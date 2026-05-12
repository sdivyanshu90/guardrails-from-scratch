import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import nlp from 'compromise';

import type { Guard, GuardConfig, GuardResult, RedactionOperation, RequestContext } from '../types.js';
import { asRecord, toNumberRecord, toStringArray } from '../utils.js';
import { MetricsCollector } from '../audit/metrics.js';

const ENTITY_PATTERNS: Record<string, RegExp> = {
  EMAIL_ADDRESS: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  PHONE_NUMBER: /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g,
  CREDIT_CARD: /\b(?:\d[ -]*?){13,19}\b/g,
  SSN: /\b\d{3}-\d{2}-\d{4}\b/g,
  IP_ADDRESS: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g,
  DATE_OF_BIRTH: /\b(?:born on|date of birth[:\s]*)\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi,
  STREET_ADDRESS: /\b\d{1,5}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\s(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Lane|Ln|Drive|Dr|Court|Ct)\b(?:,\s*[A-Za-z .'-]+,\s*[A-Z]{2})?/g
};

const DEFAULT_ENTITY_WEIGHTS: Record<string, number> = {
  EMAIL_ADDRESS: 0.2,
  PHONE_NUMBER: 0.2,
  CREDIT_CARD: 0.5,
  SSN: 0.6,
  IP_ADDRESS: 0.1,
  DATE_OF_BIRTH: 0.2,
  PERSON_NAME: 0.1,
  STREET_ADDRESS: 0.3
};

const DEFAULT_REPLACEMENTS: Record<string, string> = {
  EMAIL_ADDRESS: 'user@anonymized.com',
  PHONE_NUMBER: '+1-000-000-0000',
  CREDIT_CARD: '4000 0000 0000 0002',
  SSN: '000-00-0000',
  IP_ADDRESS: '0.0.0.0',
  DATE_OF_BIRTH: 'born on 01/01/1970',
  PERSON_NAME: 'Anonymous User',
  STREET_ADDRESS: '100 Privacy St, Redacted, ZZ'
};

const DEFAULT_ENTITIES = Object.keys(DEFAULT_ENTITY_WEIGHTS);

function isLuhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

function collectRegexMatches(content: string, type: string, pattern: RegExp): Array<{ type: string; value: string; start: number; end: number }> {
  const matches: Array<{ type: string; value: string; start: number; end: number }> = [];
  for (const match of content.matchAll(pattern)) {
    if (!match[0]) {
      continue;
    }

    if (type === 'CREDIT_CARD' && !isLuhnValid(match[0])) {
      continue;
    }

    const start = match.index ?? -1;
    if (start === -1) {
      continue;
    }

    matches.push({
      type,
      value: match[0],
      start,
      end: start + match[0].length
    });
  }

  return matches;
}

function collectPersonNameMatches(content: string): Array<{ type: string; value: string; start: number; end: number }> {
  const names = new Set<string>();
  const heuristic = /\b(?:my name is|i am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g;

  for (const match of content.matchAll(heuristic)) {
    if (match[1]) {
      names.add(match[1]);
    }
  }

  for (const person of nlp(content).people().out('array')) {
    if (typeof person === 'string' && person.split(/\s+/).length <= 3) {
      names.add(person);
    }
  }

  return [...names]
    .map((name) => {
      const start = content.indexOf(name);
      if (start === -1) {
        return undefined;
      }

      return {
        type: 'PERSON_NAME',
        value: name,
        start,
        end: start + name.length
      };
    })
    .filter((match): match is { type: string; value: string; start: number; end: number } => match !== undefined);
}

function dedupeMatches(matches: Array<{ type: string; value: string; start: number; end: number }>): Array<{ type: string; value: string; start: number; end: number }> {
  const seen = new Set<string>();
  return matches
    .sort((left, right) => left.start - right.start)
    .filter((match) => {
      const key = `${match.type}:${match.start}:${match.end}:${match.value}`;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}

export function detectPiiEntities(
  content: string,
  enabledEntities: string[] = DEFAULT_ENTITIES
): Array<{ type: string; value: string; start: number; end: number }> {
  const matches: Array<{ type: string; value: string; start: number; end: number }> = [];
  for (const entity of enabledEntities) {
    if (entity === 'PERSON_NAME') {
      matches.push(...collectPersonNameMatches(content));
      continue;
    }

    const pattern = ENTITY_PATTERNS[entity];
    if (pattern) {
      matches.push(...collectRegexMatches(content, entity, pattern));
    }
  }

  return dedupeMatches(matches);
}

function chooseStrategy(options: Record<string, unknown>, entityType: string): 'mask' | 'hash' | 'replace' {
  const strategyMap = asRecord(options.redaction_strategy_map);
  const strategy = strategyMap[entityType] ?? options.redaction_strategy;
  return strategy === 'hash' || strategy === 'replace' ? strategy : 'mask';
}

function replacementForEntity(entityType: string, value: string, options: Record<string, unknown>): string {
  const strategy = chooseStrategy(options, entityType);
  if (strategy === 'hash') {
    return `[sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}]`;
  }

  if (strategy === 'replace') {
    const customReplacements = asRecord(options.replace_values);
    const replacement = customReplacements[entityType];
    return typeof replacement === 'string' ? replacement : DEFAULT_REPLACEMENTS[entityType] ?? '[REDACTED]';
  }

  return `[${entityType.replace(/_/g, ' ')} REDACTED]`;
}

export function redactPiiEntities(
  content: string,
  entities: Array<{ type: string; value: string; start: number; end: number }>,
  options: Record<string, unknown>
): { sanitizedContent: string; operations: RedactionOperation[] } {
  let sanitizedContent = content;
  const operations: RedactionOperation[] = [];

  for (const entity of [...entities].sort((left, right) => right.start - left.start)) {
    const replacement = replacementForEntity(entity.type, entity.value, options);
    sanitizedContent = `${sanitizedContent.slice(0, entity.start)}${replacement}${sanitizedContent.slice(entity.end)}`;
    operations.push({
      type: entity.type,
      original: entity.value,
      replacement
    });
  }

  return {
    sanitizedContent,
    operations: operations.reverse()
  };
}

export class PiiDetector implements Guard {
  readonly id = 'pii-detector';
  readonly phase = 'input' as const;

  constructor(
    private readonly config: GuardConfig,
    private readonly metrics?: MetricsCollector
  ) {}

  async run(content: string, _context: RequestContext): Promise<GuardResult> {
    const startedAt = performance.now();
    const options = asRecord(this.config.options);
    const enabledEntities = toStringArray(options.entities, DEFAULT_ENTITIES);
    const weights = toNumberRecord(options.entity_weight_map, DEFAULT_ENTITY_WEIGHTS);
    const entities = detectPiiEntities(content, enabledEntities);

    const durationMs = Number((performance.now() - startedAt).toFixed(3));
    if (entities.length === 0) {
      return {
        guardId: this.id,
        verdict: 'pass',
        score: 0,
        durationMs
      };
    }

    const { sanitizedContent, operations } = redactPiiEntities(content, entities, options);
    const entityTypes = [...new Set(entities.map((entity) => entity.type))];
    for (const entityType of entityTypes) {
      this.metrics?.piiEntitiesFoundTotal.inc({ entity_type: entityType }, entities.filter((entity) => entity.type === entityType).length);
    }

    const score = Math.min(
      1,
      entities.reduce((sum, entity) => sum + (weights[entity.type] ?? 0.1), 0)
    );

    return {
      guardId: this.id,
      verdict: 'redact',
      score: Number(score.toFixed(3)),
      reason: `${entityTypes.join(', ')} found and redacted`,
      metadata: {
        entities,
        entityTypes,
        redactions: operations,
        sanitizedContent
      },
      durationMs
    };
  }
}