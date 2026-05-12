import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { AuditLogger } from './audit/logger.js';
import { MetricsCollector } from './audit/metrics.js';
import { PipelineRunner } from './pipeline.js';
import { computeCompositeScore } from './policy-router.js';
import { PiiDetector } from './input/pii-detector.js';
import { InjectionScanner } from './input/injection-scanner.js';
import { TopicClassifier } from './input/topic-classifier.js';
import { TokenBudgetGuard } from './input/token-budget.js';
import { HallucinationDetector } from './output/hallucination-detector.js';
import { ToxicityFilter } from './output/toxicity-filter.js';
import { PiiRechecker } from './output/pii-rechecker.js';
import { SchemaValidator } from './output/schema-validator.js';
import type {
  AuditEntry,
  Guard,
  GuardConfig,
  GuardedChatResult,
  GuardrailError,
  GuardrailConfig,
  LLMAdapter,
  LLMParams,
  Message,
  PipelineMode,
  PipelineResult,
  RequestContext
} from './types.js';
import { GuardrailError as GuardrailErrorClass } from './types.js';
import { asRecord, estimateTokenCount } from './utils.js';

export type GuardFactory = (config: GuardConfig) => Guard;

export interface EngineDependencies {
  auditLogger?: AuditLogger;
  metrics?: MetricsCollector;
  pipelineRunner?: PipelineRunner;
}

export interface PhaseExecutionOptions {
  phase: 'input' | 'output';
  content: string;
  context: RequestContext;
  mode?: PipelineMode;
}

export class GuardrailsEngine {
  private readonly adapters = new Map<string, LLMAdapter>();
  private readonly guardFactories = new Map<string, GuardFactory>();
  private readonly pipelineRunner: PipelineRunner;

  readonly auditLogger: AuditLogger;
  readonly metrics: MetricsCollector;

  constructor(
    private config: GuardrailConfig,
    dependencies: EngineDependencies = {}
  ) {
    this.pipelineRunner = dependencies.pipelineRunner ?? new PipelineRunner();
    this.auditLogger = dependencies.auditLogger ?? new AuditLogger(config.audit);
    this.metrics = dependencies.metrics ?? new MetricsCollector();
    this.registerBuiltInGuards();
  }

  private registerBuiltInGuards(): void {
    this.registerGuardFactory('pii-detector', (guardConfig) => new PiiDetector(guardConfig, this.metrics));
    this.registerGuardFactory('injection-scanner', (guardConfig) => new InjectionScanner(guardConfig));
    this.registerGuardFactory('topic-classifier', (guardConfig) => new TopicClassifier(guardConfig));
    this.registerGuardFactory('token-budget', (guardConfig) => new TokenBudgetGuard(guardConfig));
    this.registerGuardFactory('hallucination-detector', (guardConfig) => new HallucinationDetector(guardConfig));
    this.registerGuardFactory('toxicity-filter', (guardConfig) => new ToxicityFilter(guardConfig));
    this.registerGuardFactory('pii-rechecker', (guardConfig) => new PiiRechecker(guardConfig, this.metrics));
    this.registerGuardFactory('schema-validator', (guardConfig) => new SchemaValidator(guardConfig));
  }

  registerAdapter(providerId: string, adapter: LLMAdapter): void {
    this.adapters.set(providerId, adapter);
  }

  registerGuardFactory(guardId: string, factory: GuardFactory): void {
    this.guardFactories.set(guardId, factory);
  }

  getConfig(): GuardrailConfig {
    return this.config;
  }

  updateConfig(config: GuardrailConfig): void {
    this.config = config;
  }

  createRequestContext(
    context: Partial<RequestContext> = {}
  ): RequestContext {
    return {
      requestId: context.requestId ?? `req_${randomUUID()}`,
      ...(context.userId ? { userId: context.userId } : {}),
      ...(context.userRole ? { userRole: context.userRole } : {}),
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      timestamp: context.timestamp ?? new Date(),
      metadata: context.metadata ?? {}
    };
  }

  async runPhase(options: PhaseExecutionOptions): Promise<PipelineResult> {
    const guardConfigs = options.phase === 'input'
      ? this.config.inputGuards
      : this.config.outputGuards;

    const guards = guardConfigs
      .filter((guard) => guard.enabled)
      .map((guard) => this.guardFactories.get(guard.id)?.(guard))
      .filter((guard): guard is Guard => guard !== undefined);

    const result = await this.pipelineRunner.run({
      guards,
      content: options.content,
      context: options.context,
      config: this.config,
      phase: options.phase,
      ...((options.mode ?? (options.phase === 'input' ? this.config.inputMode : this.config.outputMode))
        ? { mode: options.mode ?? (options.phase === 'input' ? this.config.inputMode : this.config.outputMode) }
        : {})
    });

    this.metrics.requestsTotal.inc({ phase: options.phase, verdict: result.finalVerdict }, 1);
    this.metrics.compositeScore.observe(
      { phase: options.phase },
      computeCompositeScore(result.guards, this.config, options.phase)
    );

    for (const guard of result.guards) {
      this.metrics.guardDurationSeconds.observe({ guard_id: guard.guardId }, guard.durationMs / 1000);
      if (guard.verdict === 'block') {
        this.metrics.blocksTotal.inc({ guard_id: guard.guardId, reason: guard.reason ?? 'blocked' }, 1);
      }
    }

    return result;
  }

  getAdapter(providerId: string): LLMAdapter | undefined {
    return this.adapters.get(providerId);
  }

  serializeMessages(messages: Message[]): string {
    return messages
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n');
  }

  async chat(
    messages: Message[],
    params: LLMParams,
    context: Partial<RequestContext> = {}
  ): Promise<GuardedChatResult> {
    const requestContext = this.createRequestContext({
      ...context,
      metadata: {
        ...(context.metadata ?? {}),
        messages,
        inputContent: this.getPrimaryPrompt(messages)
      }
    });
    const startedAt = performance.now();
    const inputContent = this.getPrimaryPrompt(messages);
    const inputResult = await this.runPhase({
      phase: 'input',
      content: inputContent,
      context: requestContext,
      mode: this.config.inputMode ?? 'sequential'
    });

    const inputMessages = this.applyInputSanitization(messages, inputResult, inputContent);
    const maxOutputTokens = this.extractMaxOutputTokens(inputResult) ?? params.maxOutputTokens;
    const providerId = this.resolveProvider(params);
    const adapter = this.getAdapter(providerId);
    if (!adapter) {
      throw new Error(`No adapter registered for provider: ${providerId}`);
    }

    if (inputResult.finalVerdict === 'block') {
      const error = this.createBlockError(inputResult) as GuardrailError;
      await this.writeAuditEntry(this.buildAuditEntry({
        requestContext,
        inputResult,
        inputOriginal: inputContent,
        totalDurationMs: Number((performance.now() - startedAt).toFixed(3))
      }));
      throw error;
    }

    const llmStartedAt = performance.now();
    const outputContent = await adapter.chat(inputMessages, {
      ...params,
      provider: providerId,
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {})
    });
    const llmLatencyMs = Number((performance.now() - llmStartedAt).toFixed(3));
    this.metrics.llmLatencySeconds.observe({ provider: providerId, model: params.model }, llmLatencyMs / 1000);

    const outputContext = this.createRequestContext({
      ...requestContext,
      metadata: {
        ...(requestContext.metadata ?? {}),
        contextWindow: this.serializeMessages(inputMessages),
        inputContent: this.getPrimaryPrompt(inputMessages)
      }
    });

    const outputResult = await this.runPhase({
      phase: 'output',
      content: outputContent,
      context: outputContext,
      mode: this.config.outputMode ?? 'parallel'
    });

    const totalDurationMs = Number((performance.now() - startedAt).toFixed(3));
    await this.writeAuditEntry(this.buildAuditEntry({
      requestContext,
      inputOriginal: inputContent,
      inputResult,
      outputOriginal: outputContent,
      outputResult,
      providerId,
      model: params.model,
      promptTokens: estimateTokenCount(this.serializeMessages(inputMessages)),
      completionTokens: estimateTokenCount(outputContent),
      llmLatencyMs,
      totalDurationMs
    }));

    if (outputResult.finalVerdict === 'block') {
      throw this.createBlockError(outputResult);
    }

    return {
      id: requestContext.requestId,
      message: {
        role: 'assistant',
        content: outputResult.sanitizedContent
      },
      guardrails: {
        inputVerdict: inputResult.finalVerdict,
        outputVerdict: outputResult.finalVerdict,
        durationMs: totalDurationMs,
        warnings: [...this.collectWarnings(inputResult), ...this.collectWarnings(outputResult)]
      },
      input: inputResult,
      output: outputResult,
      providerId,
      model: params.model
    };
  }

  private buildAuditEntry(options: {
    requestContext: RequestContext;
    inputOriginal: string;
    inputResult: PipelineResult;
    outputOriginal?: string;
    outputResult?: PipelineResult;
    providerId?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    llmLatencyMs?: number;
    totalDurationMs: number;
  }): AuditEntry {
    return {
      timestamp: options.requestContext.timestamp.toISOString(),
      requestId: options.requestContext.requestId,
      ...(options.requestContext.userId ? { userId: options.requestContext.userId } : {}),
      ...(options.requestContext.sessionId ? { sessionId: options.requestContext.sessionId } : {}),
      input: {
        originalLength: options.inputOriginal.length,
        sanitizedLength: options.inputResult.sanitizedContent.length,
        verdict: options.inputResult.finalVerdict,
        compositeScore: computeCompositeScore(options.inputResult.guards, this.config, 'input'),
        guards: options.inputResult.guards
      },
      ...(options.providerId && options.model && options.promptTokens !== undefined && options.completionTokens !== undefined && options.llmLatencyMs !== undefined
        ? {
            llm: {
              provider: options.providerId,
              model: options.model,
              promptTokens: options.promptTokens,
              completionTokens: options.completionTokens,
              latencyMs: options.llmLatencyMs
            }
          }
        : {}),
      ...(options.outputOriginal && options.outputResult
        ? {
            output: {
              originalLength: options.outputOriginal.length,
              sanitizedLength: options.outputResult.sanitizedContent.length,
              verdict: options.outputResult.finalVerdict,
              compositeScore: computeCompositeScore(options.outputResult.guards, this.config, 'output'),
              guards: options.outputResult.guards
            }
          }
        : {}),
      totalDurationMs: options.totalDurationMs
    };
  }

  private getPrimaryPrompt(messages: Message[]): string {
    const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    return lastUserMessage?.content ?? messages.map((message) => message.content).join('\n');
  }

  private applyInputSanitization(
    messages: Message[],
    inputResult: PipelineResult,
    originalPrompt: string
  ): Message[] {
    const nextMessages = messages.map((message) => ({ ...message }));
    const lastStructuredMessages = [...inputResult.guards]
      .reverse()
      .map((result) => result.metadata?.messages)
      .find((value): value is Message[] => Array.isArray(value));

    const workingMessages = lastStructuredMessages
      ? lastStructuredMessages.map((message) => ({ ...message }))
      : nextMessages;

    if (inputResult.sanitizedContent !== originalPrompt) {
      const lastUserIndex = [...workingMessages].map((message) => message.role).lastIndexOf('user');
      const targetIndex = lastUserIndex >= 0 ? lastUserIndex : workingMessages.length - 1;
      const targetMessage = targetIndex >= 0 ? workingMessages[targetIndex] : undefined;
      if (targetMessage) {
        workingMessages[targetIndex] = {
          ...targetMessage,
          content: inputResult.sanitizedContent
        };
      }
    }

    return workingMessages;
  }

  private extractMaxOutputTokens(result: PipelineResult): number | undefined {
    for (const guardResult of [...result.guards].reverse()) {
      const metadata = asRecord(guardResult.metadata);
      if (typeof metadata.maxOutputTokens === 'number') {
        return metadata.maxOutputTokens;
      }
    }

    return undefined;
  }

  private createBlockError(result: PipelineResult): GuardrailErrorClass {
    const blockingGuard = result.guards.find((guard) => guard.verdict === 'block' || guard.score >= 1);
    return new GuardrailErrorClass(
      'GUARDRAIL_BLOCK',
      blockingGuard?.guardId ?? 'policy-router',
      blockingGuard?.reason ?? 'Guardrail policy blocked the request',
      result.requestId
    );
  }

  private collectWarnings(result: PipelineResult): string[] {
    return result.guards
      .filter((guard) => guard.verdict === 'warn' || guard.verdict === 'redact')
      .map((guard) => guard.reason)
      .filter((reason): reason is string => typeof reason === 'string' && reason.length > 0);
  }

  private resolveProvider(params: LLMParams): string {
    if (params.provider) {
      return params.provider;
    }

    const model = params.model.toLowerCase();
    if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) {
      return 'openai';
    }

    if (model.startsWith('claude')) {
      return 'anthropic';
    }

    return 'ollama';
  }

  async writeAuditEntry(entry: AuditEntry): Promise<void> {
    await this.auditLogger.log(entry);
  }
}