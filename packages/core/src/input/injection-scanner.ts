import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';

import type { Guard, GuardConfig, GuardResult, RequestContext } from '../types.js';
import { asRecord } from '../utils.js';

interface InjectionPattern {
  id: string;
  regex: RegExp;
  hardBlock?: boolean;
  severity: number;
}

const PATTERNS: InjectionPattern[] = [
  {
    id: 'IGNORE_PREV',
    regex: /ignore (all )?(previous|prior|above) instructions?/i,
    hardBlock: true,
    severity: 1
  },
  {
    id: 'ROLE_SWITCH',
    regex: /\b(?:you are now|act as|pretend (?:to be|you are))\b/i,
    severity: 0.4
  },
  {
    id: 'DAN_PATTERN',
    regex: /do anything now|dan mode|jailbreak/i,
    hardBlock: true,
    severity: 1
  },
  {
    id: 'SYS_EXTRACT',
    regex: /repeat (?:your|the) (?:system|initial) prompt/i,
    hardBlock: true,
    severity: 1
  },
  {
    id: 'DELIMITER_INJECT',
    regex: /```\s*(?:system|instructions?)/i,
    hardBlock: true,
    severity: 1
  }
];

const CREATIVE_ROLEPLAY = /pretend (?:to be|you are) (?:a|an)?\s*(pirate|poet|wizard|chef|storyteller|comedian)\b/i;

const HOMOGLYPHS: Record<string, string> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'i',
  ј: 'j'
};

function normalizeUnicodeLookalikes(text: string): string {
  return text
    .normalize('NFKC')
    .split('')
    .map((character) => HOMOGLYPHS[character] ?? character)
    .join('');
}

function extractBase64Candidates(text: string): string[] {
  return text.match(/\b[A-Za-z0-9+/=]{16,}\b/g) ?? [];
}

function decodeBase64(candidate: string): string | undefined {
  try {
    const decoded = Buffer.from(candidate, 'base64').toString('utf8');
    if (!decoded || /[^\x09\x0A\x0D\x20-\x7E]/.test(decoded)) {
      return undefined;
    }

    const normalized = Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '');
    const source = candidate.replace(/=+$/, '');
    return normalized === source ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function scanForMatches(content: string): { matched: InjectionPattern[]; roleplayAllowed: boolean } {
  const matched = PATTERNS.filter((pattern) => pattern.regex.test(content));
  const roleplayAllowed = matched.length === 1 && matched[0]?.id === 'ROLE_SWITCH' && CREATIVE_ROLEPLAY.test(content);
  return {
    matched: roleplayAllowed ? [] : matched,
    roleplayAllowed
  };
}

export class InjectionScanner implements Guard {
  readonly id = 'injection-scanner';
  readonly phase = 'input' as const;

  constructor(private readonly config: GuardConfig) {}

  async run(content: string, _context: RequestContext): Promise<GuardResult> {
    const startedAt = performance.now();
    const options = asRecord(this.config.options);
    const normalizedContent = options.check_unicode_normalization === false
      ? content
      : normalizeUnicodeLookalikes(content);
    const directScan = scanForMatches(normalizedContent);
    const base64Matches: string[] = [];
    let decodedHardBlock: string | undefined;

    if (options.check_base64 !== false) {
      for (const candidate of extractBase64Candidates(normalizedContent)) {
        const decoded = decodeBase64(candidate);
        if (!decoded) {
          continue;
        }

        const decodedScan = scanForMatches(decoded);
        if (decodedScan.matched.length > 0) {
          base64Matches.push(...decodedScan.matched.map((pattern) => pattern.id));
        }

        if (decodedScan.matched.some((pattern) => pattern.hardBlock)) {
          decodedHardBlock = decoded;
          break;
        }
      }
    }

    const durationMs = Number((performance.now() - startedAt).toFixed(3));

    if (decodedHardBlock) {
      return {
        guardId: this.id,
        verdict: 'block',
        score: 1,
        reason: 'Base64-encoded prompt injection detected',
        metadata: {
          matchedPatterns: base64Matches,
          normalizedContent,
          decodedPayload: decodedHardBlock
        },
        durationMs
      };
    }

    if (directScan.matched.some((pattern) => pattern.hardBlock)) {
      return {
        guardId: this.id,
        verdict: 'block',
        score: 1,
        reason: 'Prompt injection attempt detected',
        metadata: {
          matchedPatterns: directScan.matched.map((pattern) => pattern.id),
          normalizedContent
        },
        durationMs
      };
    }

    const uniquePatterns = [...new Set([...directScan.matched.map((pattern) => pattern.id), ...base64Matches])];
    if (uniquePatterns.length === 0) {
      return {
        guardId: this.id,
        verdict: 'pass',
        score: 0,
        metadata: {
          roleplayAllowed: directScan.roleplayAllowed
        },
        durationMs
      };
    }

    const severityMultiplier = Math.max(
      ...directScan.matched.map((pattern) => pattern.severity),
      base64Matches.length > 0 ? 0.8 : 0
    );
    const score = Math.min(0.99, (uniquePatterns.length / PATTERNS.length) * severityMultiplier);

    return {
      guardId: this.id,
      verdict: score >= 0.4 ? 'warn' : 'pass',
      score: Number(score.toFixed(3)),
      reason: `Suspicious prompt patterns matched: ${uniquePatterns.join(', ')}`,
      metadata: {
        matchedPatterns: uniquePatterns,
        normalizedContent,
        unicodeNormalized: normalizedContent !== content,
        base64Matches
      },
      durationMs
    };
  }
}