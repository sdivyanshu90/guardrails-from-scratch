import { performance } from 'node:perf_hooks';

import type { Guard, GuardConfig, GuardResult, RequestContext } from '../types.js';
import { asRecord } from '../utils.js';

const CLAIM_WITHOUT_CITATION = /\b(?:according to|stud(?:y|ies) show|research shows|source:|experts say)\b/i;
const HAS_CITATION = /(https?:\/\/\S+|\[[0-9]+\]|doi:\s*10\.|isbn[:\s])/i;
const PRECISE_STATISTICS = /(\b\d{1,3}(?:\.\d+)?%(?=\s|[.,;:]|$)|\$\d{1,3}(?:,\d{3})+(?:\.\d+)?\b)/g;
const HEDGING = /\b(?:i believe|i think|probably|likely|it seems|appears to)\b/i;
const FUTURE_YEAR = /\b(20\d{2})\b/g;
const FACTUAL_PAST_CONTEXT = /\b(?:was|were|happened|occurred|released|announced|proved)\b/i;
const URL_PATTERN = /https?:\/\/[^\s)]+/g;
const DOI_PATTERN = /\b10\.\d{4,9}\/[A-Z0-9._;()/:+-]+\b/gi;
const ISBN_PATTERN = /\b(?:97[89][- ]?)?\d[-\d ]{8,16}[\dX]\b/g;

interface HeuristicHit {
  id: string;
  weight: number;
  detail: string;
}

function extractAssertions(text: string): Array<{ subject: string; negated: boolean; predicate: string }> {
  const assertions: Array<{ subject: string; negated: boolean; predicate: string }> = [];
  const normalizedText = text
    .replace(/\b(?:i think|i believe|it seems|probably|likely|appears to)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const pattern = /\b([A-Za-z][A-Za-z0-9]*(?:\s+[A-Za-z][A-Za-z0-9]*){0,4})\s+(is|are|was|were)\s+(not\s+)?([A-Za-z0-9][A-Za-z0-9\s-]{1,50})/gi;

  for (const match of normalizedText.matchAll(pattern)) {
    const subject = match[1]?.trim();
    const predicate = match[4]?.trim();
    if (!subject || !predicate) {
      continue;
    }

    assertions.push({
      subject: subject.toLowerCase(),
      negated: Boolean(match[3]),
      predicate: predicate.toLowerCase()
    });
  }

  return assertions;
}

function detectContradiction(content: string, context: RequestContext): HeuristicHit | undefined {
  const metadata = asRecord(context.metadata);
  const contextWindow = metadata.contextWindow;
  if (typeof contextWindow !== 'string' || !contextWindow.trim()) {
    return undefined;
  }

  const sourceAssertions = extractAssertions(contextWindow);
  const outputAssertions = extractAssertions(content);

  for (const source of sourceAssertions) {
    const contradictory = outputAssertions.find((output) => {
      if (output.subject !== source.subject) {
        return false;
      }

      return output.negated !== source.negated || output.predicate !== source.predicate;
    });

    if (contradictory) {
      return {
        id: 'CONTRADICTION',
        weight: 0.3,
        detail: `Output contradicts context for subject "${source.subject}"`
      };
    }
  }

  return undefined;
}

function isValidIsbn(value: string): boolean {
  const digits = value.replace(/[^\dX]/gi, '').toUpperCase();
  if (digits.length === 10) {
    const checksum = digits.split('').reduce((sum, digit, index) => {
      const numeric = digit === 'X' ? 10 : Number(digit);
      return sum + numeric * (10 - index);
    }, 0);
    return checksum % 11 === 0;
  }

  if (digits.length === 13) {
    const checksum = digits
      .slice(0, 12)
      .split('')
      .reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
    const checkDigit = (10 - (checksum % 10)) % 10;
    return checkDigit === Number(digits[12]);
  }

  return false;
}

async function detectEntityFabrication(content: string, options: Record<string, unknown>): Promise<HeuristicHit | undefined> {
  const malformedUrl = (content.match(URL_PATTERN) ?? []).find((value) => {
    try {
      const url = new URL(value);
      return !url.hostname.includes('.');
    } catch {
      return true;
    }
  });
  if (malformedUrl) {
    return {
      id: 'ENTITY_FABRICATION',
      weight: 0.2,
      detail: `Malformed URL detected: ${malformedUrl}`
    };
  }

  const invalidIsbn = (content.match(ISBN_PATTERN) ?? []).find((value) => !isValidIsbn(value));
  if (invalidIsbn) {
    return {
      id: 'ENTITY_FABRICATION',
      weight: 0.2,
      detail: `Invalid ISBN detected: ${invalidIsbn}`
    };
  }

  const verifyEntities = options.verify_entities === true;
  if (!verifyEntities) {
    return undefined;
  }

  const timeoutMs = typeof options.verify_timeout_ms === 'number' ? options.verify_timeout_ms : 1500;
  for (const url of content.match(URL_PATTERN) ?? []) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) {
        return {
          id: 'ENTITY_FABRICATION',
          weight: 0.2,
          detail: `Unreachable URL detected: ${url}`
        };
      }
    } catch {
      return {
        id: 'ENTITY_FABRICATION',
        weight: 0.2,
        detail: `Unverified URL detected: ${url}`
      };
    }
  }

  for (const doi of content.match(DOI_PATTERN) ?? []) {
    if (!DOI_PATTERN.test(doi)) {
      return {
        id: 'ENTITY_FABRICATION',
        weight: 0.2,
        detail: `Malformed DOI detected: ${doi}`
      };
    }
  }

  return undefined;
}

export class HallucinationDetector implements Guard {
  readonly id = 'hallucination-detector';
  readonly phase = 'output' as const;

  constructor(private readonly config: GuardConfig) {}

  async run(content: string, context: RequestContext): Promise<GuardResult> {
    const startedAt = performance.now();
    const options = asRecord(this.config.options);
    const hits: HeuristicHit[] = [];

    if (CLAIM_WITHOUT_CITATION.test(content) && !HAS_CITATION.test(content)) {
      hits.push({
        id: 'CITATION_MISSING',
        weight: 0.2,
        detail: 'Citation-style phrasing present without a real citation'
      });
    }

    if ((content.match(PRECISE_STATISTICS) ?? []).length > 0 && !HAS_CITATION.test(content)) {
      hits.push({
        id: 'FAKE_STATISTICS',
        weight: 0.25,
        detail: 'Precise statistics appear without attribution'
      });
    }

    const currentYear = context.timestamp.getUTCFullYear();
    for (const match of content.matchAll(FUTURE_YEAR)) {
      const year = Number(match[1]);
      if (year > currentYear && FACTUAL_PAST_CONTEXT.test(content)) {
        hits.push({
          id: 'DATE_ANOMALY',
          weight: 0.2,
          detail: `Future year ${year} stated as a past fact`
        });
        break;
      }
    }

    const contradiction = detectContradiction(content, context);
    if (contradiction) {
      hits.push(contradiction);
    }

    if (HEDGING.test(content) && /\b(?:is|are|was|were|has|have)\b/i.test(content)) {
      hits.push({
        id: 'CONFIDENCE_HEDGING',
        weight: 0.1,
        detail: 'Factual-sounding claim includes confidence hedging'
      });
    }

    const entityFabrication = await detectEntityFabrication(content, options);
    if (entityFabrication) {
      hits.push(entityFabrication);
    }

    const durationMs = Number((performance.now() - startedAt).toFixed(3));
    if (hits.length === 0) {
      return {
        guardId: this.id,
        verdict: 'pass',
        score: 0,
        durationMs
      };
    }

    const score = Math.min(1, hits.reduce((sum, hit) => sum + hit.weight, 0));
    return {
      guardId: this.id,
      verdict: score >= 0.25 ? 'warn' : 'pass',
      score: Number(score.toFixed(3)),
      reason: hits.map((hit) => hit.id).join(', '),
      metadata: {
        heuristics: hits
      },
      durationMs
    };
  }
}