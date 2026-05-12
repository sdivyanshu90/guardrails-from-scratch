import type { LLMAdapter, LLMParams, Message } from '../types.js';

import { iterateUtf8Lines } from './stream-utils.js';

interface OllamaResponse {
  message?: {
    content?: string;
  };
  done?: boolean;
}

export class OllamaAdapter implements LLMAdapter {
  readonly providerId = 'ollama';

  constructor(private readonly options: { baseUrl: string }) {}

  async chat(messages: Message[], params: LLMParams): Promise<string> {
    const response = await fetch(`${this.options.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: params.model,
        messages,
        stream: false,
        options: {
          temperature: params.temperature,
          num_predict: params.maxOutputTokens
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama chat request failed with ${response.status}`);
    }

    const payload = await response.json() as OllamaResponse;
    return payload.message?.content ?? '';
  }

  async *stream(messages: Message[], params: LLMParams): AsyncIterable<string> {
    const response = await fetch(`${this.options.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: params.model,
        messages,
        stream: true,
        options: {
          temperature: params.temperature,
          num_predict: params.maxOutputTokens
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama stream request failed with ${response.status}`);
    }

    for await (const line of iterateUtf8Lines(response.body)) {
      if (!line) {
        continue;
      }

      const parsed = JSON.parse(line) as OllamaResponse;
      const chunk = parsed.message?.content;
      if (chunk) {
        yield chunk;
      }

      if (parsed.done) {
        return;
      }
    }
  }
}