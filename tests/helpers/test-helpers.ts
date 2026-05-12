import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigManager,
  GuardrailsEngine,
  serializeGuardrailConfig,
  type GuardrailConfig,
  type LLMAdapter,
  type LLMParams,
  type Message
} from '@guardrails/core';

export function createTestConfig(overrides: Partial<GuardrailConfig> = {}): GuardrailConfig {
  const base: GuardrailConfig = {
    thresholds: {
      warn: 0.4,
      block: 0.7
    },
    inputGuards: [
      { id: 'pii-detector', enabled: true, weight: 0.8, options: { redaction_strategy: 'mask' } },
      { id: 'injection-scanner', enabled: true, weight: 1.0, options: { check_base64: true, check_unicode_normalization: true } },
      { id: 'topic-classifier', enabled: true, weight: 0.9 },
      { id: 'token-budget', enabled: true, weight: 0.3, options: { max_input_tokens: 4096, max_output_tokens: 2048, conversation_budget: 32768 } }
    ],
    outputGuards: [
      { id: 'hallucination-detector', enabled: true, weight: 0.5 },
      { id: 'toxicity-filter', enabled: true, weight: 0.8, options: { provider: 'local', threshold: 0.5 } },
      { id: 'pii-rechecker', enabled: true, weight: 0.9 },
      { id: 'schema-validator', enabled: true, weight: 0.3, options: { max_length_chars: 8000, format_rules: { mode: 'plain-text' } } }
    ],
    audit: {
      enabled: true,
      level: 'standard',
      destination: 'file',
      filePath: './logs/test-audit.jsonl'
    },
    failMode: 'open',
    inputMode: 'sequential',
    outputMode: 'parallel'
  };

  return {
    ...base,
    ...overrides,
    thresholds: {
      ...base.thresholds,
      ...overrides.thresholds
    },
    inputGuards: overrides.inputGuards ?? base.inputGuards,
    outputGuards: overrides.outputGuards ?? base.outputGuards,
    audit: {
      ...base.audit,
      ...overrides.audit
    },
    ...(overrides.policyOverrides ? { policyOverrides: overrides.policyOverrides } : {}),
    ...(overrides.failMode ? { failMode: overrides.failMode } : {}),
    ...(overrides.inputMode ? { inputMode: overrides.inputMode } : {}),
    ...(overrides.outputMode ? { outputMode: overrides.outputMode } : {})
  };
}

export class MockAdapter implements LLMAdapter {
  readonly providerId = 'openai';
  readonly calls: Array<{ messages: Message[]; params: LLMParams }> = [];

  constructor(private readonly responseText = 'Safe response') {}

  async chat(messages: Message[], params: LLMParams): Promise<string> {
    this.calls.push({
      messages: messages.map((message) => ({ ...message })),
      params: { ...params }
    });
    return this.responseText;
  }

  async *stream(messages: Message[], params: LLMParams): AsyncIterable<string> {
    yield await this.chat(messages, params);
  }
}

export async function createTestServices(responseText = 'Safe response', overrides: Partial<GuardrailConfig> = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'guardrails-tests-'));
  const auditFile = join(tempDir, 'audit.jsonl');
  const configPath = join(tempDir, 'rules.yaml');
  const config = createTestConfig({
    ...overrides,
    audit: {
      enabled: true,
      level: 'standard',
      destination: 'file',
      filePath: auditFile
    }
  });

  await writeFile(configPath, serializeGuardrailConfig(config), 'utf8');

  const configManager = new ConfigManager(configPath, config);
  const engine = new GuardrailsEngine(config);
  const adapter = new MockAdapter(responseText);
  engine.registerAdapter('openai', adapter);

  return {
    tempDir,
    auditFile,
    configPath,
    configManager,
    engine,
    adapter,
    cleanup: async () => {
      await configManager.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}