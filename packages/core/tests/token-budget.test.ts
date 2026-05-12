import { describe, expect, it } from 'vitest';

import { TokenBudgetGuard, asRecord } from '@guardrails/core';

const context = {
  requestId: 'req_budget',
  timestamp: new Date('2026-05-12T00:00:00.000Z'),
  metadata: {}
};

describe('TokenBudgetGuard', () => {
  it('truncates prompts over the soft limit', async () => {
    const guard = new TokenBudgetGuard({
      id: 'token-budget',
      enabled: true,
      weight: 0.3,
      options: { max_input_tokens: 10, max_output_tokens: 20 }
    });
    const result = await guard.run('A'.repeat(80), context);
    const metadata = asRecord(result.metadata);

    expect(result.verdict).toBe('warn');
    expect(String(metadata.sanitizedContent)).toContain('[...truncated]');
  });

  it('blocks prompts over the hard limit', async () => {
    const guard = new TokenBudgetGuard({
      id: 'token-budget',
      enabled: true,
      weight: 0.3,
      options: { max_input_tokens: 5, max_output_tokens: 20 }
    });
    const result = await guard.run('A'.repeat(50), context);

    expect(result.verdict).toBe('block');
    expect(result.score).toBe(1);
  });

  it('trims conversation budget by dropping oldest turns', async () => {
    const guard = new TokenBudgetGuard({
      id: 'token-budget',
      enabled: true,
      weight: 0.3,
      options: { max_input_tokens: 1000, max_output_tokens: 20, conversation_budget: 8 }
    });
    const result = await guard.run('short prompt', {
      ...context,
      metadata: {
        messages: [
          { role: 'user', content: 'This is a very old message that should be dropped.' },
          { role: 'assistant', content: 'Old response.' },
          { role: 'user', content: 'Recent question.' }
        ]
      }
    });
    const metadata = asRecord(result.metadata);
    const messages = Array.isArray(metadata.messages) ? metadata.messages : [];

    expect(result.verdict).toBe('warn');
    expect(messages.length).toBeLessThan(3);
  });
});