import { readFile, writeFile } from 'node:fs/promises';

import chokidar, { type FSWatcher } from 'chokidar';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import type { GuardConfig, GuardrailConfig, RuleUpdate } from './types.js';

const guardConfigSchema = z.object({
  id: z.string(),
  enabled: z.boolean().default(true),
  weight: z.number().min(0).max(1),
  options: z.record(z.unknown()).optional()
});

const policyOverrideSchema = z.object({
  condition: z.enum(['topic', 'user_role', 'regex']),
  value: z.string(),
  action: z.enum(['always_block', 'always_allow', 'escalate'])
});

const rawConfigSchema = z.object({
  version: z.string().optional(),
  thresholds: z.object({
    warn: z.number().min(0).max(1).default(0.4),
    block: z.number().min(0).max(1).default(0.7)
  }),
  input_guards: z.array(guardConfigSchema).default([]),
  output_guards: z.array(guardConfigSchema).default([]),
  policy_overrides: z.array(policyOverrideSchema).optional(),
  audit: z.object({
    enabled: z.boolean().default(true),
    level: z.enum(['minimal', 'standard', 'verbose']).default('standard'),
    destination: z.enum(['console', 'file', 'http']).default('console'),
    file_path: z.string().optional(),
    http_endpoint: z.string().url().optional()
  }),
  fail_mode: z.enum(['open', 'closed']).default('open'),
  input_mode: z.enum(['sequential', 'parallel']).optional(),
  output_mode: z.enum(['sequential', 'parallel']).optional()
});

function normalizeGuardConfig(guard: z.infer<typeof guardConfigSchema>): GuardConfig {
  return {
    id: guard.id,
    enabled: guard.enabled,
    weight: guard.weight,
    ...(guard.options ? { options: guard.options } : {})
  };
}

export function normalizeConfig(raw: unknown): GuardrailConfig {
  const parsed = rawConfigSchema.parse(raw);
  return {
    thresholds: parsed.thresholds,
    inputGuards: parsed.input_guards.map(normalizeGuardConfig),
    outputGuards: parsed.output_guards.map(normalizeGuardConfig),
    ...(parsed.policy_overrides ? { policyOverrides: parsed.policy_overrides } : {}),
    audit: {
      enabled: parsed.audit.enabled,
      level: parsed.audit.level,
      destination: parsed.audit.destination,
      ...(parsed.audit.file_path ? { filePath: parsed.audit.file_path } : {}),
      ...(parsed.audit.http_endpoint ? { httpEndpoint: parsed.audit.http_endpoint } : {})
    },
    failMode: parsed.fail_mode,
    ...(parsed.input_mode ? { inputMode: parsed.input_mode } : {}),
    ...(parsed.output_mode ? { outputMode: parsed.output_mode } : {})
  };
}

export async function loadGuardrailConfig(filePath: string): Promise<GuardrailConfig> {
  const fileContents = await readFile(filePath, 'utf8');
  const parsed = parse(fileContents);
  return normalizeConfig(parsed);
}

export function serializeGuardrailConfig(config: GuardrailConfig): string {
  return stringify({
    version: '1.0',
    thresholds: config.thresholds,
    input_guards: config.inputGuards.map(serializeGuardConfig),
    output_guards: config.outputGuards.map(serializeGuardConfig),
    ...(config.policyOverrides ? { policy_overrides: config.policyOverrides } : {}),
    audit: {
      enabled: config.audit.enabled,
      level: config.audit.level,
      destination: config.audit.destination,
      ...(config.audit.filePath ? { file_path: config.audit.filePath } : {}),
      ...(config.audit.httpEndpoint ? { http_endpoint: config.audit.httpEndpoint } : {})
    },
    fail_mode: config.failMode ?? 'open',
    ...(config.inputMode ? { input_mode: config.inputMode } : {}),
    ...(config.outputMode ? { output_mode: config.outputMode } : {})
  });
}

function serializeGuardConfig(guard: GuardConfig): Record<string, unknown> {
  return {
    id: guard.id,
    enabled: guard.enabled,
    weight: guard.weight,
    ...(guard.options ? { options: guard.options } : {})
  };
}

export class ConfigManager {
  private watcher: FSWatcher | undefined;
  private listeners = new Set<(config: GuardrailConfig) => void>();

  constructor(
    private readonly filePath: string,
    private config: GuardrailConfig
  ) {}

  static async fromFile(filePath: string): Promise<ConfigManager> {
    const config = await loadGuardrailConfig(filePath);
    return new ConfigManager(filePath, config);
  }

  getConfig(): GuardrailConfig {
    return this.config;
  }

  listRules(): Array<GuardConfig & { phase: 'input' | 'output' }> {
    return [
      ...this.config.inputGuards.map((guard) => ({ ...guard, phase: 'input' as const })),
      ...this.config.outputGuards.map((guard) => ({ ...guard, phase: 'output' as const }))
    ];
  }

  async reload(): Promise<GuardrailConfig> {
    this.config = await loadGuardrailConfig(this.filePath);
    this.emit();
    return this.config;
  }

  async updateRule(ruleId: string, update: RuleUpdate): Promise<GuardConfig | undefined> {
    let updatedRule: GuardConfig | undefined;
    const applyUpdate = (guard: GuardConfig): GuardConfig => {
      if (guard.id !== ruleId) {
        return guard;
      }

      const nextRule: GuardConfig = {
        id: guard.id,
        enabled: update.enabled ?? guard.enabled,
        weight: update.weight ?? guard.weight,
        ...((update.options ?? guard.options) ? { options: update.options ?? guard.options } : {})
      };

      updatedRule = nextRule;
      return nextRule;
    };

    const nextConfig: GuardrailConfig = {
      ...this.config,
      inputGuards: this.config.inputGuards.map(applyUpdate),
      outputGuards: this.config.outputGuards.map(applyUpdate)
    };

    if (!updatedRule) {
      return undefined;
    }

    this.config = nextConfig;
    await writeFile(this.filePath, serializeGuardrailConfig(this.config), 'utf8');
    this.emit();
    return updatedRule;
  }

  watch(): void {
    if (this.watcher) {
      return;
    }

    this.watcher = chokidar.watch(this.filePath, {
      ignoreInitial: true
    });

    this.watcher.on('change', () => {
      void this.reload();
    });
  }

  async close(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }
  }

  onChange(listener: (config: GuardrailConfig) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.config);
    }
  }
}