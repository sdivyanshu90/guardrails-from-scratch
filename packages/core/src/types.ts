export type GuardVerdict = 'pass' | 'warn' | 'block' | 'redact';

export interface GuardResult {
  guardId: string;
  verdict: GuardVerdict;
  score: number;
  reason?: string;
  metadata?: Record<string, unknown>;
  durationMs: number;
}

export interface PipelineResult {
  requestId: string;
  finalVerdict: GuardVerdict;
  guards: GuardResult[];
  sanitizedContent: string;
  totalDurationMs: number;
}

export interface GuardrailConfig {
  thresholds: {
    warn: number;
    block: number;
  };
  inputGuards: GuardConfig[];
  outputGuards: GuardConfig[];
  policyOverrides?: PolicyOverride[];
  audit: {
    enabled: boolean;
    level: 'minimal' | 'standard' | 'verbose';
    destination: 'console' | 'file' | 'http';
    filePath?: string;
    httpEndpoint?: string;
  };
  failMode?: 'open' | 'closed';
  inputMode?: PipelineMode;
  outputMode?: PipelineMode;
}

export interface GuardConfig {
  id: string;
  enabled: boolean;
  weight: number;
  options?: Record<string, unknown>;
}

export interface PolicyOverride {
  condition: 'topic' | 'user_role' | 'regex';
  value: string;
  action: 'always_block' | 'always_allow' | 'escalate';
}

export interface Guard {
  readonly id: string;
  readonly phase: 'input' | 'output';
  run(content: string, context: RequestContext): Promise<GuardResult>;
}

export interface RequestContext {
  requestId: string;
  userId?: string;
  userRole?: string;
  sessionId?: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export type PipelineMode = 'sequential' | 'parallel';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
}

export interface LLMParams {
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  stream?: boolean;
  provider?: string;
  metadata?: Record<string, unknown>;
}

export interface LLMAdapter {
  readonly providerId: string;
  chat(messages: Message[], params: LLMParams): Promise<string>;
  stream(messages: Message[], params: LLMParams): AsyncIterable<string>;
}

export interface PipelineRunOptions {
  guards: Guard[];
  content: string;
  context: RequestContext;
  config: GuardrailConfig;
  phase: 'input' | 'output';
  mode?: PipelineMode;
}

export interface GuardExecutionFailure {
  guardId: string;
  error: Error;
  failMode: 'open' | 'closed';
}

export interface EntityMatch {
  type: string;
  value: string;
  start: number;
  end: number;
}

export interface RedactionOperation {
  type: string;
  original: string;
  replacement: string;
}

export interface AuditPhaseRecord {
  originalLength: number;
  sanitizedLength: number;
  verdict: GuardVerdict;
  compositeScore: number;
  guards: GuardResult[];
}

export interface AuditEntry {
  timestamp: string;
  requestId: string;
  userId?: string;
  sessionId?: string;
  input: AuditPhaseRecord;
  llm?: {
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
  };
  output?: AuditPhaseRecord;
  totalDurationMs: number;
}

export interface GuardrailsSummary {
  inputVerdict: GuardVerdict;
  outputVerdict: GuardVerdict;
  durationMs: number;
  warnings: string[];
}

export interface GuardedChatResult {
  id: string;
  message: Message;
  guardrails: GuardrailsSummary;
  input: PipelineResult;
  output: PipelineResult;
  providerId: string;
  model: string;
}

export interface RuleUpdate {
  enabled?: boolean;
  weight?: number;
  options?: Record<string, unknown>;
}

export class GuardrailError extends Error {
  readonly code: string;
  readonly guardId: string;
  readonly requestId: string;

  constructor(code: string, guardId: string, reason: string, requestId: string) {
    super(reason);
    this.name = 'GuardrailError';
    this.code = code;
    this.guardId = guardId;
    this.requestId = requestId;
  }

  toJSON(): { code: string; guardId: string; reason: string; requestId: string } {
    return {
      code: this.code,
      guardId: this.guardId,
      reason: this.message,
      requestId: this.requestId
    };
  }
}