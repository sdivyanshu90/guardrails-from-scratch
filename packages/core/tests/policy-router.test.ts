import { describe, expect, it } from 'vitest';

import { computeVerdict, type GuardResult, type RequestContext } from '@guardrails/core';

import { createTestConfig } from '../../../tests/helpers/test-helpers.js';

const context: RequestContext = {
  requestId: 'req_policy',
  timestamp: new Date('2026-05-12T00:00:00.000Z')
};

describe('policy-router', () => {
  it('blocks when any guard returns score >= 1.0', () => {
    const results: GuardResult[] = [
      { guardId: 'injection-scanner', verdict: 'block', score: 1, durationMs: 1 }
    ];

    const decision = computeVerdict(results, createTestConfig(), 'input', 'prompt', context);
    expect(decision.verdict).toBe('block');
  });

  it('warns when the composite score lands in the warn band', () => {
    const results: GuardResult[] = [
      { guardId: 'pii-detector', verdict: 'redact', score: 0.6, durationMs: 1 },
      { guardId: 'topic-classifier', verdict: 'warn', score: 0.6, durationMs: 1 }
    ];

    const decision = computeVerdict(results, createTestConfig(), 'input', 'prompt', context);
    expect(decision.verdict).toBe('warn');
  });

  it('passes when all guards return low scores', () => {
    const results: GuardResult[] = [
      { guardId: 'pii-detector', verdict: 'pass', score: 0, durationMs: 1 },
      { guardId: 'topic-classifier', verdict: 'pass', score: 0.1, durationMs: 1 }
    ];

    const decision = computeVerdict(results, createTestConfig(), 'input', 'prompt', context);
    expect(decision.verdict).toBe('pass');
  });

  it('applies policy overrides correctly', () => {
    const config = createTestConfig({
      policyOverrides: [
        { condition: 'user_role', value: 'free_tier', action: 'escalate' }
      ]
    });
    const results: GuardResult[] = [
      { guardId: 'pii-detector', verdict: 'pass', score: 0, durationMs: 1 }
    ];

    const decision = computeVerdict(results, config, 'input', 'prompt', {
      ...context,
      userRole: 'free_tier'
    });
    expect(decision.verdict).toBe('warn');
  });
});