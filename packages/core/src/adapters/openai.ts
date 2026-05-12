import type { LLMAdapter, LLMParams, Message } from '../types.js';

import { iterateUtf8Lines } from './stream-utils.js';

interface OpenAIChatCompletion {
  choices?: Array<{
    message?: {
      content?: string;
    };
    delta?: {
      content?: string;
    };
  }>;
}

export class OpenAIAdapter implements LLMAdapter {
  readonly providerId = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.openai.com/v1'
  ) {}

  async chat(messages: Message[], params: LLMParams): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: params.model,
        messages,
        temperature: params.temperature,
        max_tokens: params.maxOutputTokens,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI chat request failed with ${response.status}`);
    }

    const payload = await response.json() as OpenAIChatCompletion;
    return payload.choices?.[0]?.message?.content ?? '';
  }

  async *stream(messages: Message[], params: LLMParams): AsyncIterable<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: params.model,
        messages,
        temperature: params.temperature,
        max_tokens: params.maxOutputTokens,
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI stream request failed with ${response.status}`);
    }

    for await (const line of iterateUtf8Lines(response.body)) {
      if (!line.startsWith('data:')) {
        continue;
      }

      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }

      const parsed = JSON.parse(payload) as OpenAIChatCompletion;
      const chunk = parsed.choices?.[0]?.delta?.content;
      if (chunk) {
        yield chunk;
      }
    }
  }
}