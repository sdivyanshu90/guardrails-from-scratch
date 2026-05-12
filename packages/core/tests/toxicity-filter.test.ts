import { describe, expect, it } from 'vitest';

import { ToxicityFilter } from '@guardrails/core';

const context = {
  requestId: 'req_toxicity',
  timestamp: new Date('2026-05-12T00:00:00.000Z')
};

describe('ToxicityFilter', () => {
  it('blocks clearly toxic output when threshold is low enough', async () => {
    const guard = new ToxicityFilter({
      id: 'toxicity-filter',
      enabled: true,
      weight: 0.8,
      options: {
        provider: 'local',
        categories: ['HARASSMENT', 'SELF_HARM'],
        threshold: 0.1
      }
    });
    const result = await guard.run('You are an idiot and you should kill yourself.', context);

    expect(result.verdict).toBe('block');
  });

  it('passes clean output', async () => {
    const guard = new ToxicityFilter({
      id: 'toxicity-filter',
      enabled: true,
      weight: 0.8,
      options: {
        provider: 'local'
      }
    });
    const result = await guard.run('Here is a calm, factual answer about string reversal.', context);

    expect(result.verdict).toBe('pass');
    expect(result.score).toBe(0);
  });
});