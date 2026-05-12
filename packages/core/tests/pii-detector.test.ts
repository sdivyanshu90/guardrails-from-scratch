import { describe, expect, it } from 'vitest';

import { PiiDetector, asRecord } from '@guardrails/core';

const context = {
  requestId: 'req_pii',
  timestamp: new Date('2026-05-12T00:00:00.000Z')
};

describe('PiiDetector', () => {
  it('detects email addresses', async () => {
    const guard = new PiiDetector({ id: 'pii-detector', enabled: true, weight: 0.8 });
    const result = await guard.run('Reach me at user@example.com', context);

    expect(result.verdict).toBe('redact');
    expect(result.score).toBeGreaterThan(0);
    expect(asRecord(result.metadata).sanitizedContent).toContain('REDACTED');
  });

  it('detects credit card numbers when Luhn-valid', async () => {
    const guard = new PiiDetector({ id: 'pii-detector', enabled: true, weight: 0.8 });
    const result = await guard.run('Card 4111 1111 1111 1111 should be hidden.', context);

    expect(result.verdict).toBe('redact');
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('masks entities in output', async () => {
    const guard = new PiiDetector({
      id: 'pii-detector',
      enabled: true,
      weight: 0.8,
      options: { redaction_strategy: 'mask' }
    });
    const result = await guard.run('My SSN is 123-45-6789.', context);
    const metadata = asRecord(result.metadata);

    expect(metadata.sanitizedContent).not.toContain('123-45-6789');
    expect(metadata.sanitizedContent).toContain('REDACTED');
  });

  it('returns score 0.0 for clean input', async () => {
    const guard = new PiiDetector({ id: 'pii-detector', enabled: true, weight: 0.8 });
    const result = await guard.run('What is the capital of Japan?', context);

    expect(result.verdict).toBe('pass');
    expect(result.score).toBe(0);
  });

  it('handles multiple entities in one message', async () => {
    const guard = new PiiDetector({ id: 'pii-detector', enabled: true, weight: 0.8 });
    const result = await guard.run('Email me at user@example.com or call +1-555-867-5309.', context);
    const metadata = asRecord(result.metadata);
    const entities = Array.isArray(metadata.entities) ? metadata.entities : [];

    expect(entities).toHaveLength(2);
    expect(result.score).toBeGreaterThan(0.3);
  });
});