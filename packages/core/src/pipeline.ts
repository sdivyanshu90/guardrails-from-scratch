import { performance } from 'node:perf_hooks';

import { computeVerdict } from './policy-router.js';
import type {
  Guard,
  GuardResult,
  GuardrailConfig,
  PipelineResult,
  PipelineRunOptions,
  RequestContext
} from './types.js';

function coerceError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === 'string' ? error : 'Unknown guard failure');
}

function createFailureResult(
  guard: Guard,
  context: RequestContext,
  config: GuardrailConfig,
  error: unknown
): GuardResult {
  const failMode = config.failMode ?? 'open';
  const failure = coerceError(error);
  return {
    guardId: guard.id,
    verdict: failMode === 'closed' ? 'block' : 'pass',
    score: failMode === 'closed' ? 1 : 0,
    reason: failMode === 'closed'
      ? `Guard failed closed: ${failure.message}`
      : `Guard failed open: ${failure.message}`,
    metadata: {
      error: failure.message,
      requestId: context.requestId,
      failMode
    },
    durationMs: 0
  };
}

function applySanitizer(currentContent: string, result: GuardResult): string {
  const sanitized = result.metadata?.sanitizedContent;
  return typeof sanitized === 'string' ? sanitized : currentContent;
}

export class PipelineRunner {
  async run(options: PipelineRunOptions): Promise<PipelineResult> {
    const startedAt = performance.now();
    const mode = options.mode ?? 'sequential';

    if (mode === 'parallel') {
      return this.runParallel(options, startedAt);
    }

    return this.runSequential(options, startedAt);
  }

  private async runSequential(
    options: PipelineRunOptions,
    startedAt: number
  ): Promise<PipelineResult> {
    let currentContent = options.content;
    const results: GuardResult[] = [];

    for (const guard of options.guards) {
      try {
        const result = await guard.run(currentContent, options.context);
        results.push(result);
        currentContent = applySanitizer(currentContent, result);

        if (result.verdict === 'block' || result.score >= 1) {
          break;
        }
      } catch (error) {
        const fallback = createFailureResult(guard, options.context, options.config, error);
        results.push(fallback);
        if (fallback.verdict === 'block') {
          break;
        }
      }
    }

    const decision = computeVerdict(
      results,
      options.config,
      options.phase,
      currentContent,
      options.context
    );

    return {
      requestId: options.context.requestId,
      finalVerdict: decision.verdict,
      guards: results,
      sanitizedContent: currentContent,
      totalDurationMs: Number((performance.now() - startedAt).toFixed(3))
    };
  }

  private async runParallel(
    options: PipelineRunOptions,
    startedAt: number
  ): Promise<PipelineResult> {
    const settledResults = await Promise.all(
      options.guards.map(async (guard) => {
        try {
          return await guard.run(options.content, options.context);
        } catch (error) {
          return createFailureResult(guard, options.context, options.config, error);
        }
      })
    );

    let currentContent = options.content;
    for (const result of settledResults) {
      currentContent = applySanitizer(currentContent, result);
    }

    const decision = computeVerdict(
      settledResults,
      options.config,
      options.phase,
      currentContent,
      options.context
    );

    return {
      requestId: options.context.requestId,
      finalVerdict: decision.verdict,
      guards: settledResults,
      sanitizedContent: currentContent,
      totalDurationMs: Number((performance.now() - startedAt).toFixed(3))
    };
  }
}