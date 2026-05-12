import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  GuardrailsEngine,
  type GuardrailConfig,
  type LLMAdapter,
  type LLMParams,
  serializeGuardrailConfig
} from '@guardrails/core';

class BenchmarkAdapter implements LLMAdapter {
  readonly providerId = 'openai';

  async chat(): Promise<string> {
    return 'Use Python slicing like text[::-1] or reversed().';
  }

  async *stream(_messages: never, _params: LLMParams): AsyncIterable<string> {
    yield 'Use Python slicing like text[::-1] or reversed().';
  }
}

function createBenchmarkConfig(auditFile: string): GuardrailConfig {
  return {
    thresholds: { warn: 0.4, block: 0.7 },
    inputGuards: [
      { id: 'pii-detector', enabled: true, weight: 0.8 },
      { id: 'injection-scanner', enabled: true, weight: 1.0 },
      { id: 'topic-classifier', enabled: true, weight: 0.9 },
      { id: 'token-budget', enabled: true, weight: 0.3 }
    ],
    outputGuards: [
      { id: 'hallucination-detector', enabled: true, weight: 0.5 },
      { id: 'toxicity-filter', enabled: true, weight: 0.8, options: { provider: 'local' } },
      { id: 'pii-rechecker', enabled: true, weight: 0.9 },
      { id: 'schema-validator', enabled: true, weight: 0.3, options: { max_length_chars: 8000 } }
    ],
    audit: {
      enabled: true,
      level: 'minimal',
      destination: 'file',
      filePath: auditFile
    },
    failMode: 'open',
    inputMode: 'sequential',
    outputMode: 'parallel'
  };
}

async function main(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'guardrails-bench-'));
  const configPath = join(tempDir, 'rules.yaml');
  const auditFile = join(tempDir, 'audit.jsonl');
  const config = createBenchmarkConfig(auditFile);
  await writeFile(configPath, serializeGuardrailConfig(config), 'utf8');

  const engine = new GuardrailsEngine(config);
  engine.registerAdapter('openai', new BenchmarkAdapter());

  const runs = 200;
  const latencies: number[] = [];
  const startedAt = performance.now();

  for (let index = 0; index < runs; index += 1) {
    const cycleStartedAt = performance.now();
    await engine.chat([
      {
        role: 'user',
        content: 'How do I reverse a string in Python?'
      }
    ], {
      model: 'gpt-4o-mini'
    });
    latencies.push(performance.now() - cycleStartedAt);
  }

  latencies.sort((left, right) => left - right);
  const totalMs = performance.now() - startedAt;
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? 0;
  const reqPerSec = (runs / totalMs) * 1000;

  process.stdout.write(JSON.stringify({
    runs,
    requestsPerSecond: Number(reqPerSec.toFixed(2)),
    p50Ms: Number(p50.toFixed(3)),
    p99Ms: Number(p99.toFixed(3))
  }, null, 2));
  process.stdout.write('\n');
}

void main();