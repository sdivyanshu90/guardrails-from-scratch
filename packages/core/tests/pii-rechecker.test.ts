import { describe, expect, it } from 'vitest';

import { PiiRechecker, asRecord } from '@guardrails/core';

const context = {
  requestId: 'req_pii_out',
  timestamp: new Date('2026-05-12T00:00:00.000Z')
};

describe('PiiRechecker', () => {
  it('redacts PII in model output', async () => {
    const guard = new PiiRechecker({ id: 'pii-rechecker', enabled: true, weight: 0.9 });
    const result = await guard.run('Sure, your email is user@example.com.', context);
    const metadata = asRecord(result.metadata);

    expect(result.verdict).toBe('redact');
    expect(String(metadata.sanitizedContent)).not.toContain('user@example.com');
  });

  it('passes clean output', async () => {
    const guard = new PiiRechecker({ id: 'pii-rechecker', enabled: true, weight: 0.9 });
    const result = await guard.run('I can help explain Python slicing.', context);

    expect(result.verdict).toBe('pass');
    expect(result.score).toBe(0);
  });
});