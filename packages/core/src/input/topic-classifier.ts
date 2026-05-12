import { performance } from 'node:perf_hooks';

import type { Guard, GuardConfig, GuardResult, RequestContext } from '../types.js';
import { asRecord, cosineSimilarity, toStringArray } from '../utils.js';

type TopicCategory =
  | 'WEAPONS_MASS_DESTRUCTION'
  | 'CSAM'
  | 'SELF_HARM_INSTRUCTIONS'
  | 'FINANCIAL_ADVICE'
  | 'LEGAL_ADVICE'
  | 'COMPETITOR_MENTIONS'
  | 'OFF_TOPIC'
  | 'CODING'
  | 'GENERAL_QA'
  | 'CREATIVE_WRITING';

const TOPIC_PATTERNS: Record<TopicCategory, RegExp[]> = {
  WEAPONS_MASS_DESTRUCTION: [
    /weapon(?:s)? of mass destruction/i,
    /dirty bomb/i,
    /weaponize (?:a )?(?:pathogen|virus|agent)/i,
    /nerve agent/i
  ],
  CSAM: [
    /child sexual abuse material/i,
    /sexual exploitation of minors/i,
    /abuse image of a child/i
  ],
  SELF_HARM_INSTRUCTIONS: [
    /how to (?:kill|hurt) myself/i,
    /best way to commit suicide/i,
    /self-harm instructions/i
  ],
  FINANCIAL_ADVICE: [
    /which stock should i buy/i,
    /investment advice/i,
    /how should i allocate my portfolio/i
  ],
  LEGAL_ADVICE: [
    /legal advice/i,
    /can i sue/i,
    /how do i avoid prosecution/i
  ],
  COMPETITOR_MENTIONS: [
    /openai|anthropic|gemini|claude/i
  ],
  OFF_TOPIC: [],
  CODING: [
    /\b(code|debug|typescript|python|javascript|api|regex|database|query|compile)\b/i
  ],
  GENERAL_QA: [
    /\b(what|why|how|when|where|explain)\b/i
  ],
  CREATIVE_WRITING: [
    /\b(write|compose|draft)\b.*\b(story|poem|script|essay)\b/i,
    /pretend you are a pirate/i
  ]
};

const SEMANTIC_SEEDS: Record<TopicCategory, string[]> = {
  WEAPONS_MASS_DESTRUCTION: ['build a dirty bomb', 'create a chemical weapon', 'cause mass casualty with toxins'],
  CSAM: ['illegal sexual content involving minors', 'abusive content with children'],
  SELF_HARM_INSTRUCTIONS: ['instructions to commit suicide', 'ways to self harm'],
  FINANCIAL_ADVICE: ['tell me which investment to choose', 'recommend a stock to buy'],
  LEGAL_ADVICE: ['tell me how to win a lawsuit', 'give me legal counsel'],
  COMPETITOR_MENTIONS: ['compare this company to a competitor', 'mention rival ai providers'],
  OFF_TOPIC: ['random unrelated chatter', 'content not related to supported tasks'],
  CODING: ['debug this code snippet', 'write a typescript function'],
  GENERAL_QA: ['answer a general knowledge question', 'explain a concept'],
  CREATIVE_WRITING: ['write a short story', 'compose a poem']
};

const DEFAULT_ALWAYS_BLOCK: TopicCategory[] = ['WEAPONS_MASS_DESTRUCTION', 'CSAM', 'SELF_HARM_INSTRUCTIONS'];
const DEFAULT_ALLOW: TopicCategory[] = ['CODING', 'GENERAL_QA', 'CREATIVE_WRITING'];

function scoreSemanticTopic(content: string, topics: TopicCategory[], threshold: number): TopicCategory | undefined {
  let bestTopic: TopicCategory | undefined;
  let bestScore = 0;

  for (const topic of topics) {
    for (const seed of SEMANTIC_SEEDS[topic]) {
      const score = cosineSimilarity(content, seed);
      if (score > bestScore) {
        bestScore = score;
        bestTopic = topic;
      }
    }
  }

  return bestScore >= threshold ? bestTopic : undefined;
}

function tierOneMatch(content: string, topics: TopicCategory[]): TopicCategory | undefined {
  for (const topic of topics) {
    if (TOPIC_PATTERNS[topic].some((pattern) => pattern.test(content))) {
      return topic;
    }
  }

  return undefined;
}

export class TopicClassifier implements Guard {
  readonly id = 'topic-classifier';
  readonly phase = 'input' as const;

  constructor(private readonly config: GuardConfig) {}

  async run(content: string, _context: RequestContext): Promise<GuardResult> {
    const startedAt = performance.now();
    const options = asRecord(this.config.options);
    const alwaysBlock = toStringArray(options.always_block, DEFAULT_ALWAYS_BLOCK) as TopicCategory[];
    const configurableDeny = toStringArray(options.configurable_deny, []) as TopicCategory[];
    const configurableAllow = toStringArray(options.configurable_allow, DEFAULT_ALLOW) as TopicCategory[];
    const semanticEnabled = options.semantic_enabled === true;
    const semanticThreshold = typeof options.semantic_threshold === 'number' ? options.semantic_threshold : 0.72;

    let matchedTopic = tierOneMatch(content, alwaysBlock);
    let tier: 'tier1' | 'tier2' = 'tier1';

    if (!matchedTopic) {
      matchedTopic = tierOneMatch(content, configurableDeny);
    }

    if (!matchedTopic) {
      matchedTopic = tierOneMatch(content, configurableAllow);
    }

    if (!matchedTopic && semanticEnabled) {
      matchedTopic = scoreSemanticTopic(content, [...alwaysBlock, ...configurableDeny, ...configurableAllow], semanticThreshold);
      if (matchedTopic) {
        tier = 'tier2';
      }
    }

    const offTopicEnabled = configurableDeny.includes('OFF_TOPIC');
    const durationMs = Number((performance.now() - startedAt).toFixed(3));

    if (!matchedTopic) {
      if (offTopicEnabled) {
        return {
          guardId: this.id,
          verdict: 'warn',
          score: 0.45,
          reason: 'Request appears off-topic for the configured policy',
          metadata: {
            topic: 'OFF_TOPIC',
            tier
          },
          durationMs
        };
      }

      return {
        guardId: this.id,
        verdict: 'pass',
        score: 0,
        metadata: {
          topic: 'GENERAL_QA',
          tier
        },
        durationMs
      };
    }

    if (alwaysBlock.includes(matchedTopic)) {
      return {
        guardId: this.id,
        verdict: 'block',
        score: 1,
        reason: `Blocked topic category detected: ${matchedTopic}`,
        metadata: {
          topic: matchedTopic,
          tier
        },
        durationMs
      };
    }

    if (configurableDeny.includes(matchedTopic)) {
      const score = matchedTopic === 'OFF_TOPIC' ? 0.45 : 0.8;
      return {
        guardId: this.id,
        verdict: 'warn',
        score,
        reason: `Denied topic category detected: ${matchedTopic}`,
        metadata: {
          topic: matchedTopic,
          tier
        },
        durationMs
      };
    }

    return {
      guardId: this.id,
      verdict: 'pass',
      score: 0,
      metadata: {
        topic: matchedTopic,
        tier
      },
      durationMs
    };
  }
}