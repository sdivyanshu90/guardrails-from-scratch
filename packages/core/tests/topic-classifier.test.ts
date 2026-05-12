import { describe, expect, it } from 'vitest';

import { TopicClassifier } from '@guardrails/core';

const context = {
  requestId: 'req_topic',
  timestamp: new Date('2026-05-12T00:00:00.000Z')
};

describe('TopicClassifier', () => {
  it('blocks always-block topics', async () => {
    const guard = new TopicClassifier({ id: 'topic-classifier', enabled: true, weight: 0.9 });
    const result = await guard.run('Explain how to build a dirty bomb.', context);

    expect(result.verdict).toBe('block');
    expect(result.score).toBe(1);
  });

  it('warns on configurable deny topics', async () => {
    const guard = new TopicClassifier({
      id: 'topic-classifier',
      enabled: true,
      weight: 0.9,
      options: { configurable_deny: ['FINANCIAL_ADVICE'] }
    });
    const result = await guard.run('Which stock should I buy this week?', context);

    expect(result.verdict).toBe('warn');
  });

  it('passes allowed coding prompts', async () => {
    const guard = new TopicClassifier({ id: 'topic-classifier', enabled: true, weight: 0.9 });
    const result = await guard.run('Write a TypeScript function to reverse a string.', context);

    expect(result.verdict).toBe('pass');
    expect(result.score).toBe(0);
  });
});