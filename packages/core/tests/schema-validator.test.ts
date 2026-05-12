import { describe, expect, it } from 'vitest';

import { SchemaValidator, asRecord } from '@guardrails/core';

const context = {
  requestId: 'req_schema',
  timestamp: new Date('2026-05-12T00:00:00.000Z')
};

describe('SchemaValidator', () => {
  it('truncates responses beyond the maximum length', async () => {
    const guard = new SchemaValidator({
      id: 'schema-validator',
      enabled: true,
      weight: 0.3,
      options: { max_length_chars: 20 }
    });
    const result = await guard.run('This response is definitely longer than twenty characters.', context);
    const metadata = asRecord(result.metadata);

    expect(result.verdict).toBe('redact');
    expect(String(metadata.sanitizedContent)).toContain('[...truncated]');
  });

  it('warns when JSON schema validation fails', async () => {
    const guard = new SchemaValidator({
      id: 'schema-validator',
      enabled: true,
      weight: 0.3,
      options: {
        json_schema: {
          type: 'object',
          properties: {
            answer: { type: 'string' }
          },
          required: ['answer']
        }
      }
    });
    const result = await guard.run('{"answer":1}', context);

    expect(result.verdict).toBe('warn');
    expect(result.score).toBeGreaterThanOrEqual(0.8);
  });

  it('warns on raw HTML in plain-text mode', async () => {
    const guard = new SchemaValidator({
      id: 'schema-validator',
      enabled: true,
      weight: 0.3,
      options: { format_rules: { mode: 'plain-text' } }
    });
    const result = await guard.run('<div>unsafe html</div>', context);

    expect(result.verdict).toBe('warn');
    expect(result.score).toBeGreaterThan(0.5);
  });
});