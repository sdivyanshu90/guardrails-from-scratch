import type { Message } from './types.js';

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

export function toStringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  return value.filter((item): item is string => typeof item === 'string');
}

export function toNumberRecord(
  value: unknown,
  fallback: Record<string, number> = {}
): Record<string, number> {
  const record = asRecord(value);
  const normalized: Record<string, number> = {};

  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      normalized[key] = entry;
    }
  }

  return Object.keys(normalized).length === 0 ? fallback : normalized;
}

export function estimateTokenCount(text: string): number {
  if (!text.trim()) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}

export function normalizeForSimilarity(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

export function cosineSimilarity(left: string, right: string): number {
  const leftTokens = normalizeForSimilarity(left);
  const rightTokens = normalizeForSimilarity(right);

  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const leftVector = buildTermVector(leftTokens);
  const rightVector = buildTermVector(rightTokens);

  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  const keys = new Set([...Object.keys(leftVector), ...Object.keys(rightVector)]);
  for (const key of keys) {
    const leftValue = leftVector[key] ?? 0;
    const rightValue = rightVector[key] ?? 0;
    dotProduct += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function buildTermVector(tokens: string[]): Record<string, number> {
  return tokens.reduce<Record<string, number>>((vector, token) => {
    vector[token] = (vector[token] ?? 0) + 1;
    return vector;
  }, {});
}

export function isLikelyEnglish(text: string): boolean {
  const normalized = text.toLowerCase();
  const stopwords = ['the', 'and', 'is', 'to', 'of', 'in', 'that', 'for', 'with'];
  const matches = stopwords.reduce((count, word) => count + (normalized.includes(` ${word} `) ? 1 : 0), 0);
  const asciiLetters = (text.match(/[a-z]/gi) ?? []).length;
  const nonAscii = (text.match(/[^\x00-\x7F]/g) ?? []).length;

  return matches >= 2 || (asciiLetters > 0 && nonAscii < asciiLetters / 10);
}

export function parseMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const record = asRecord(entry);
      const role = record.role;
      const content = record.content;
      if (typeof role !== 'string' || typeof content !== 'string') {
        return undefined;
      }

      if (!['system', 'user', 'assistant', 'tool'].includes(role)) {
        return undefined;
      }

      return {
        role: role as Message['role'],
        content
      };
    })
    .filter((message): message is Message => message !== undefined);
}

export function truncateToTokenBudget(text: string, maxTokens: number, suffix = '[...truncated]'): string {
  const currentTokens = estimateTokenCount(text);
  if (currentTokens <= maxTokens) {
    return text;
  }

  const ratio = maxTokens / currentTokens;
  const sliceLength = Math.max(0, Math.floor(text.length * ratio) - suffix.length);
  return `${text.slice(0, sliceLength).trimEnd()} ${suffix}`.trim();
}