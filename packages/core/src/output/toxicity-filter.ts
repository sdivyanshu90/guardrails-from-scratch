import { performance } from 'node:perf_hooks';

import type { Guard, GuardConfig, GuardResult, RequestContext } from '../types.js';
import { asRecord, toStringArray } from '../utils.js';

type ToxicityCategory = 'HATE_SPEECH' | 'HARASSMENT' | 'PROFANITY' | 'SELF_HARM';

const LOCAL_RULES: Record<ToxicityCategory, RegExp[]> = {
  HATE_SPEECH: [
    /\bsubhuman\b/i,
    /\binferior race\b/i,
    /\bvermin\b/i,
    /\bexterminate (?:them|those people)\b/i,
    /\bgo back to where you came from\b/i
  ],
  HARASSMENT: [
    /\byou are (?:an )?(?:idiot|moron|loser|pathetic)\b/i,
    /\bnobody likes you\b/i,
    /\bshut up\b/i,
    /\byou should be ashamed\b/i,
    /\byou are worthless\b/i,
    /\bwhat is wrong with you\b/i
  ],
  PROFANITY: [
    /\bdamn\b/i,
    /\bhell\b/i,
    /\bcrap\b/i,
    /\bf\w{2}k\b/i,
    /\bs\w{2}t\b/i,
    /\bbastard\b/i,
    /\basshole\b/i
  ],
  SELF_HARM: [
    /\bkill yourself\b/i,
    /\bend your life\b/i,
    /\byou should die\b/i,
    /\bhurt yourself\b/i,
    /\bcut yourself\b/i
  ]
};

const CATEGORY_WEIGHTS: Record<ToxicityCategory, number> = {
  HATE_SPEECH: 0.35,
  HARASSMENT: 0.25,
  PROFANITY: 0.15,
  SELF_HARM: 0.5
};

async function runOpenAIModeration(content: string): Promise<Record<string, number>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for openai-moderation');
  }

  const response = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ input: content })
  });

  if (!response.ok) {
    throw new Error(`OpenAI moderation request failed with ${response.status}`);
  }

  const payload = await response.json() as {
    results?: Array<{ category_scores?: Record<string, number> }>;
  };
  return payload.results?.[0]?.category_scores ?? {};
}

async function runPerspectiveApi(content: string): Promise<Record<string, number>> {
  const apiKey = process.env.PERSPECTIVE_API_KEY;
  if (!apiKey) {
    throw new Error('PERSPECTIVE_API_KEY is required for perspective-api');
  }

  const response = await fetch(`https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      comment: {
        text: content
      },
      requestedAttributes: {
        TOXICITY: {},
        SEVERE_TOXICITY: {},
        INSULT: {},
        THREAT: {}
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Perspective API request failed with ${response.status}`);
  }

  const payload = await response.json() as {
    attributeScores?: Record<string, { summaryScore?: { value?: number } }>;
  };

  return {
    toxicity: payload.attributeScores?.TOXICITY?.summaryScore?.value ?? 0,
    severe_toxicity: payload.attributeScores?.SEVERE_TOXICITY?.summaryScore?.value ?? 0,
    insult: payload.attributeScores?.INSULT?.summaryScore?.value ?? 0,
    threat: payload.attributeScores?.THREAT?.summaryScore?.value ?? 0
  };
}

function runLocalRules(content: string, categories: ToxicityCategory[]): { score: number; categoryScores: Record<string, number> } {
  const categoryScores: Record<string, number> = {};
  let weightedTotal = 0;
  let totalWeight = 0;

  for (const category of categories) {
    const rules = LOCAL_RULES[category] ?? [];
    const matches = rules.filter((pattern) => pattern.test(content)).length;
    const score = rules.length === 0 ? 0 : matches / rules.length;
    categoryScores[category] = Number(score.toFixed(3));
    weightedTotal += score * (CATEGORY_WEIGHTS[category] ?? 0.2);
    totalWeight += CATEGORY_WEIGHTS[category] ?? 0.2;
  }

  return {
    score: totalWeight === 0 ? 0 : Number((weightedTotal / totalWeight).toFixed(3)),
    categoryScores
  };
}

function mapExternalScores(
  provider: 'openai-moderation' | 'perspective-api',
  rawScores: Record<string, number>,
  categories: ToxicityCategory[]
): { score: number; categoryScores: Record<string, number> } {
  const categoryScores: Record<string, number> = {};

  for (const category of categories) {
    let score = 0;
    switch (category) {
      case 'HATE_SPEECH':
        score = rawScores.hate ?? rawScores.identity_attack ?? rawScores.severe_toxicity ?? 0;
        break;
      case 'HARASSMENT':
        score = rawScores.harassment ?? rawScores.insult ?? rawScores.toxicity ?? 0;
        break;
      case 'PROFANITY':
        score = provider === 'openai-moderation' ? rawScores.violence ?? 0 : rawScores.toxicity ?? 0;
        break;
      case 'SELF_HARM':
        score = rawScores.self_harm ?? rawScores.threat ?? 0;
        break;
    }

    categoryScores[category] = Number(score.toFixed(3));
  }

  const total = Object.values(categoryScores).reduce((sum, value) => sum + value, 0);
  return {
    score: Number((total / categories.length).toFixed(3)),
    categoryScores
  };
}

export class ToxicityFilter implements Guard {
  readonly id = 'toxicity-filter';
  readonly phase = 'output' as const;

  constructor(private readonly config: GuardConfig) {}

  async run(content: string, _context: RequestContext): Promise<GuardResult> {
    const startedAt = performance.now();
    const options = asRecord(this.config.options);
    const provider = options.provider === 'openai-moderation' || options.provider === 'perspective-api'
      ? options.provider
      : 'local';
    const categories = (toStringArray(options.categories, ['HATE_SPEECH', 'HARASSMENT', 'PROFANITY', 'SELF_HARM']) as ToxicityCategory[]);
    const threshold = typeof options.threshold === 'number' ? options.threshold : 0.5;

    let result: { score: number; categoryScores: Record<string, number> };
    if (provider === 'local') {
      result = runLocalRules(content, categories);
    } else if (provider === 'openai-moderation') {
      result = mapExternalScores(provider, await runOpenAIModeration(content), categories);
    } else {
      result = mapExternalScores(provider, await runPerspectiveApi(content), categories);
    }

    const durationMs = Number((performance.now() - startedAt).toFixed(3));
    if (result.score === 0) {
      return {
        guardId: this.id,
        verdict: 'pass',
        score: 0,
        durationMs
      };
    }

    const verdict = result.score >= threshold ? 'block' : result.score >= threshold / 2 ? 'warn' : 'pass';
    return {
      guardId: this.id,
      verdict,
      score: result.score,
      reason: `Toxicity signals detected via ${provider}`,
      metadata: {
        provider,
        categoryScores: result.categoryScores
      },
      durationMs
    };
  }
}