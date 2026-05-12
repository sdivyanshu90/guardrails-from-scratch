import type {
  GuardConfig,
  GuardResult,
  GuardrailConfig,
  GuardVerdict,
  PolicyOverride,
  RequestContext
} from './types.js';

export interface PolicyDecision {
  verdict: GuardVerdict;
  compositeScore: number;
  matchedOverride?: PolicyOverride;
}

function getGuardConfigs(
  phase: 'input' | 'output',
  config: GuardrailConfig
): GuardConfig[] {
  return phase === 'input' ? config.inputGuards : config.outputGuards;
}

export function computeCompositeScore(
  results: GuardResult[],
  config: GuardrailConfig,
  phase: 'input' | 'output'
): number {
  if (results.length === 0) {
    return 0;
  }

  const guardConfigs = getGuardConfigs(phase, config);
  let weightedScore = 0;
  let totalWeight = 0;

  for (const result of results) {
    const guardConfig = guardConfigs.find((guard) => guard.id === result.guardId);
    const weight = guardConfig?.weight ?? 1;
    weightedScore += result.score * weight;
    totalWeight += weight;
  }

  return totalWeight === 0 ? 0 : Number((weightedScore / totalWeight).toFixed(4));
}

function findOverride(
  content: string,
  context: RequestContext,
  results: GuardResult[],
  config: GuardrailConfig
): PolicyOverride | undefined {
  const overrides = config.policyOverrides ?? [];
  for (const override of overrides) {
    if (override.condition === 'user_role' && context.userRole === override.value) {
      return override;
    }

    if (override.condition === 'regex') {
      const regex = new RegExp(override.value, 'i');
      if (regex.test(content)) {
        return override;
      }
    }

    if (override.condition === 'topic') {
      const matched = results.some((result) => result.metadata?.topic === override.value);
      if (matched) {
        return override;
      }
    }
  }

  return undefined;
}

function escalateVerdict(verdict: GuardVerdict): GuardVerdict {
  switch (verdict) {
    case 'pass':
      return 'warn';
    case 'warn':
    case 'redact':
      return 'block';
    case 'block':
      return 'block';
  }
}

export function computeVerdict(
  results: GuardResult[],
  config: GuardrailConfig,
  phase: 'input' | 'output',
  content = '',
  context: RequestContext = {
    requestId: 'unknown',
    timestamp: new Date()
  }
): PolicyDecision {
  const matchedOverride = findOverride(content, context, results, config);

  if (matchedOverride?.action === 'always_block') {
    return {
      verdict: 'block',
      compositeScore: 1,
      ...(matchedOverride ? { matchedOverride } : {})
    };
  }

  if (results.some((result) => result.score >= 1 || result.verdict === 'block')) {
    return {
      verdict: 'block',
      compositeScore: 1,
      ...(matchedOverride ? { matchedOverride } : {})
    };
  }

  const compositeScore = computeCompositeScore(results, config, phase);

  let verdict: GuardVerdict = 'pass';
  if (compositeScore >= config.thresholds.block) {
    verdict = 'block';
  } else if (compositeScore >= config.thresholds.warn) {
    verdict = 'warn';
  } else if (results.some((result) => result.verdict === 'redact')) {
    verdict = 'warn';
  }

  if (matchedOverride?.action === 'always_allow') {
    verdict = verdict === 'block' ? 'warn' : 'pass';
  }

  if (matchedOverride?.action === 'escalate') {
    verdict = escalateVerdict(verdict);
  }

  return {
    verdict,
    compositeScore,
    ...(matchedOverride ? { matchedOverride } : {})
  };
}