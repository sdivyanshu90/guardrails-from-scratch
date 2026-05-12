import { performance } from 'node:perf_hooks';

import type { Guard, GuardConfig, GuardResult, RequestContext } from '../types.js';
import { MetricsCollector } from '../audit/metrics.js';
import { detectPiiEntities, redactPiiEntities } from '../input/pii-detector.js';
import { asRecord, toNumberRecord, toStringArray } from '../utils.js';

const DEFAULT_ENTITY_WEIGHTS: Record<string, number> = {
  EMAIL_ADDRESS: 0.2,
  PHONE_NUMBER: 0.2,
  CREDIT_CARD: 0.5,
  SSN: 0.6,
  IP_ADDRESS: 0.1,
  DATE_OF_BIRTH: 0.2,
  PERSON_NAME: 0.1,
  STREET_ADDRESS: 0.3
};

export class PiiRechecker implements Guard {
  readonly id = 'pii-rechecker';
  readonly phase = 'output' as const;

  constructor(
    private readonly config: GuardConfig,
    private readonly metrics?: MetricsCollector
  ) {}

  async run(content: string, _context: RequestContext): Promise<GuardResult> {
    const startedAt = performance.now();
    const options = asRecord(this.config.options);
    const enabledEntities = toStringArray(options.entities, Object.keys(DEFAULT_ENTITY_WEIGHTS));
    const weights = toNumberRecord(options.entity_weight_map, DEFAULT_ENTITY_WEIGHTS);
    const entities = detectPiiEntities(content, enabledEntities);
    const durationMs = Number((performance.now() - startedAt).toFixed(3));

    if (entities.length === 0) {
      return {
        guardId: this.id,
        verdict: 'pass',
        score: 0,
        durationMs
      };
    }

    const { sanitizedContent, operations } = redactPiiEntities(content, entities, options);
    const entityTypes = [...new Set(entities.map((entity) => entity.type))];
    for (const entityType of entityTypes) {
      this.metrics?.piiEntitiesFoundTotal.inc({ entity_type: entityType }, entities.filter((entity) => entity.type === entityType).length);
    }

    const score = Math.min(1, entities.reduce((sum, entity) => sum + (weights[entity.type] ?? 0.1), 0));
    return {
      guardId: this.id,
      verdict: 'redact',
      score: Number(score.toFixed(3)),
      reason: `${entityTypes.join(', ')} detected in model output`,
      metadata: {
        entities,
        entityTypes,
        redactions: operations,
        sanitizedContent
      },
      durationMs
    };
  }
}