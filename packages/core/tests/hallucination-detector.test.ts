import { describe, expect, it } from 'vitest';

import { HallucinationDetector, asRecord } from '@guardrails/core';

const context = {
  requestId: 'req_hallucination',
  timestamp: new Date('2026-05-12T00:00:00.000Z')
};

describe('HallucinationDetector', () => {
  it('flags citation-free factual claims with precise statistics', async () => {
    const guard = new HallucinationDetector({ id: 'hallucination-detector', enabled: true, weight: 0.5 });
    const result = await guard.run('According to recent studies, 97.23% of startups fail within 18 months.', context);

    expect(result.verdict).toBe('warn');
    expect(result.score).toBeGreaterThanOrEqual(0.4);
  });

  it('detects contradiction against a provided context window', async () => {
    const guard = new HallucinationDetector({ id: 'hallucination-detector', enabled: true, weight: 0.5 });
    const result = await guard.run('I think Paris is not in France.', {
      ...context,
      metadata: {
        contextWindow: 'Paris is in France.'
      }
    });
    const metadata = asRecord(result.metadata);
    const heuristics = Array.isArray(metadata.heuristics) ? metadata.heuristics : [];

    expect(heuristics.some((hit) => asRecord(hit).id === 'CONTRADICTION')).toBe(true);
  });

  it('passes cited claims with a real URL', async () => {
    const guard = new HallucinationDetector({ id: 'hallucination-detector', enabled: true, weight: 0.5 });
    const result = await guard.run('According to https://example.com, Python uses indentation for blocks.', context);

    expect(result.verdict).toBe('pass');
    expect(result.score).toBe(0);
  });
});