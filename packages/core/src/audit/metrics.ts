import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics
} from 'prom-client';

export class MetricsCollector {
  readonly registry = new Registry();
  readonly requestsTotal: Counter<'phase' | 'verdict'>;
  readonly guardDurationSeconds: Histogram<'guard_id'>;
  readonly compositeScore: Histogram<'phase'>;
  readonly blocksTotal: Counter<'guard_id' | 'reason'>;
  readonly piiEntitiesFoundTotal: Counter<'entity_type'>;
  readonly llmLatencySeconds: Histogram<'provider' | 'model'>;

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'guardrails_' });

    this.requestsTotal = new Counter({
      name: 'guardrails_requests_total',
      help: 'Total guardrail requests by phase and verdict',
      labelNames: ['phase', 'verdict'],
      registers: [this.registry]
    });

    this.guardDurationSeconds = new Histogram({
      name: 'guardrails_guard_duration_seconds',
      help: 'Guard execution duration in seconds',
      labelNames: ['guard_id'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
      registers: [this.registry]
    });

    this.compositeScore = new Histogram({
      name: 'guardrails_composite_score',
      help: 'Composite score by phase',
      labelNames: ['phase'],
      buckets: [0.1, 0.25, 0.4, 0.7, 0.9, 1],
      registers: [this.registry]
    });

    this.blocksTotal = new Counter({
      name: 'guardrails_blocks_total',
      help: 'Total blocks by guard and reason',
      labelNames: ['guard_id', 'reason'],
      registers: [this.registry]
    });

    this.piiEntitiesFoundTotal = new Counter({
      name: 'guardrails_pii_entities_found_total',
      help: 'Detected PII entities by type',
      labelNames: ['entity_type'],
      registers: [this.registry]
    });

    this.llmLatencySeconds = new Histogram({
      name: 'guardrails_llm_latency_seconds',
      help: 'LLM latency in seconds by provider and model',
      labelNames: ['provider', 'model'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [this.registry]
    });
  }

  async metrics(): Promise<string> {
    return this.registry.metrics();
  }
}