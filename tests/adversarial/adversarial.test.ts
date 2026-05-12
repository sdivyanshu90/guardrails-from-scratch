import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { type GuardVerdict } from '@guardrails/core';

import { createTestServices } from '../helpers/test-helpers.js';

interface AttackVector {
  id: string;
  input: string;
  expected_verdict: GuardVerdict;
  expected_guard: string;
}

describe('adversarial vectors', () => {
  it('passes the attack-vector suite with at least 95% accuracy', async () => {
    const services = await createTestServices('Safe response');

    try {
      const raw = await readFile(new URL('./attack-vectors.yaml', import.meta.url), 'utf8');
      const vectors = parse(raw) as AttackVector[];
      let correct = 0;

      for (const vector of vectors) {
        const result = await services.engine.runPhase({
          phase: 'input',
          content: vector.input,
          context: services.engine.createRequestContext(),
          mode: 'sequential'
        });

        if (result.finalVerdict === vector.expected_verdict) {
          correct += 1;
        }

        if (vector.expected_guard !== 'none') {
          expect(result.guards.some((guard) => guard.guardId === vector.expected_guard && guard.score > 0)).toBe(true);
        }
      }

      const accuracy = correct / vectors.length;
      expect(accuracy).toBeGreaterThanOrEqual(0.95);
    } finally {
      await services.cleanup();
    }
  });
});