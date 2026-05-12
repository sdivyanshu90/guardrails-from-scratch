import { performance } from 'node:perf_hooks';

import type { Guard, GuardConfig, GuardResult, Message, RequestContext } from '../types.js';
import { asRecord, estimateTokenCount, parseMessages, truncateToTokenBudget } from '../utils.js';

function trimConversation(messages: Message[], budget: number): { messages: Message[]; trimmed: boolean } {
  if (messages.length === 0) {
    return { messages, trimmed: false };
  }

  const systemMessages = messages.filter((message) => message.role === 'system');
  const rollingMessages = messages.filter((message) => message.role !== 'system');
  let current = [...rollingMessages];

  const totalTokens = () => [...systemMessages, ...current].reduce((sum, message) => sum + estimateTokenCount(message.content), 0);
  while (current.length > 1 && totalTokens() > budget) {
    current = current.slice(1);
  }

  return {
    messages: [...systemMessages, ...current],
    trimmed: current.length !== rollingMessages.length
  };
}

export class TokenBudgetGuard implements Guard {
  readonly id = 'token-budget';
  readonly phase = 'input' as const;

  constructor(private readonly config: GuardConfig) {}

  async run(content: string, context: RequestContext): Promise<GuardResult> {
    const startedAt = performance.now();
    const options = asRecord(this.config.options);
    const maxInputTokens = typeof options.max_input_tokens === 'number' ? options.max_input_tokens : 4096;
    const maxOutputTokens = typeof options.max_output_tokens === 'number' ? options.max_output_tokens : 2048;
    const conversationBudget = typeof options.conversation_budget === 'number' ? options.conversation_budget : 32768;
    const inputTokens = estimateTokenCount(content);
    const messages = parseMessages(context.metadata?.messages);

    const trimmedConversation = trimConversation(messages, conversationBudget);
    const durationMs = Number((performance.now() - startedAt).toFixed(3));

    if (inputTokens > maxInputTokens * 2) {
      return {
        guardId: this.id,
        verdict: 'block',
        score: 1,
        reason: `Prompt exceeds hard budget: ${inputTokens} > ${maxInputTokens * 2} tokens`,
        metadata: {
          inputTokens,
          maxInputTokens,
          maxOutputTokens,
          messages: trimmedConversation.messages
        },
        durationMs
      };
    }

    if (inputTokens > maxInputTokens || trimmedConversation.trimmed) {
      const truncated = inputTokens > maxInputTokens
        ? truncateToTokenBudget(content, maxInputTokens)
        : content;
      const overageRatio = inputTokens > maxInputTokens
        ? (inputTokens / maxInputTokens) - 1
        : 0;
      const score = inputTokens > maxInputTokens
        ? Math.min(0.95, Number((0.2 + overageRatio * 0.8).toFixed(3)))
        : 0.25;

      return {
        guardId: this.id,
        verdict: 'warn',
        score,
        reason: inputTokens > maxInputTokens
          ? 'Prompt was truncated to fit token budget'
          : 'Conversation window trimmed to fit rolling budget',
        metadata: {
          inputTokens,
          maxInputTokens,
          maxOutputTokens,
          sanitizedContent: truncated,
          messages: trimmedConversation.messages,
          conversationTrimmed: trimmedConversation.trimmed
        },
        durationMs
      };
    }

    return {
      guardId: this.id,
      verdict: 'pass',
      score: 0,
      metadata: {
        inputTokens,
        maxInputTokens,
        maxOutputTokens,
        messages: trimmedConversation.messages
      },
      durationMs
    };
  }
}