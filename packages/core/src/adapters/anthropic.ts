import type { LLMAdapter, LLMParams, Message } from '../types.js';

import { iterateUtf8Lines } from './stream-utils.js';

interface AnthropicMessageResponse {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
}

export class AnthropicAdapter implements LLMAdapter {
  readonly providerId = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.anthropic.com/v1'
  ) {}

  async chat(messages: Message[], params: LLMParams): Promise<string> {
    const { system, conversation } = splitSystemPrompt(messages);
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.maxOutputTokens ?? 2048,
        temperature: params.temperature,
        system,
        messages: conversation
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic chat request failed with ${response.status}`);
    }

    const payload = await response.json() as AnthropicMessageResponse;
    return payload.content?.map((part) => part.text ?? '').join('') ?? '';
  }

  async *stream(messages: Message[], params: LLMParams): AsyncIterable<string> {
    const { system, conversation } = splitSystemPrompt(messages);
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.maxOutputTokens ?? 2048,
        temperature: params.temperature,
        system,
        messages: conversation,
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic stream request failed with ${response.status}`);
    }

    for await (const line of iterateUtf8Lines(response.body)) {
      if (!line.startsWith('data:')) {
        continue;
      }

      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }

      const parsed = JSON.parse(payload) as {
        type?: string;
        delta?: {
          text?: string;
        };
      };

      if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
        yield parsed.delta.text;
      }
    }
  }
}

function splitSystemPrompt(messages: Message[]): { system: string; conversation: Array<{ role: 'user' | 'assistant'; content: string }> } {
  return {
    system: messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n'),
    conversation: messages
      .filter((message): message is Message & { role: 'user' | 'assistant' } => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({
        role: message.role,
        content: message.content
      }))
  };
}