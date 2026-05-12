import type { Express, Request, Response } from 'express';
import { z } from 'zod';

import { GuardrailError, type GuardrailsEngine, type Message, type RequestContext } from '@guardrails/core';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string()
});

const chatContextSchema = z.object({
  userId: z.string().optional(),
  userRole: z.string().optional(),
  sessionId: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
}).optional();

const chatRequestSchema = z.object({
  messages: z.array(messageSchema).min(1),
  model: z.string(),
  stream: z.boolean().optional(),
  context: chatContextSchema
});

function chunkText(content: string, size = 160): string[] {
  if (!content) {
    return [];
  }

  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += size) {
    chunks.push(content.slice(index, index + size));
  }

  return chunks;
}

function toRequestContext(context: z.infer<typeof chatContextSchema>): Partial<RequestContext> {
  if (!context) {
    return {};
  }

  return {
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.userRole ? { userRole: context.userRole } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.metadata ? { metadata: context.metadata } : {})
  };
}

function handleChatError(error: unknown, response: Response): void {
  if (error instanceof GuardrailError) {
    response.status(400).json({
      error: error.toJSON()
    });
    return;
  }

  const reason = error instanceof Error ? error.message : 'Unexpected server error';
  response.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      reason
    }
  });
}

export function registerChatRoutes(app: Express, engine: GuardrailsEngine): void {
  app.post('/v1/chat', async (request: Request, response: Response) => {
    try {
      const payload = chatRequestSchema.parse(request.body);
      const result = await engine.chat(payload.messages as Message[], {
        model: payload.model,
        ...(payload.stream !== undefined ? { stream: payload.stream } : {})
      }, toRequestContext(payload.context));

      response.status(200).json({
        id: result.id,
        message: result.message,
        guardrails: result.guardrails
      });
    } catch (error) {
      handleChatError(error, response);
    }
  });

  app.post('/v1/chat/stream', async (request: Request, response: Response) => {
    try {
      const payload = chatRequestSchema.parse(request.body);
      const result = await engine.chat(payload.messages as Message[], {
        model: payload.model,
        stream: true
      }, toRequestContext(payload.context));

      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Connection', 'keep-alive');

      for (const chunk of chunkText(result.message.content)) {
        response.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`);
      }

      response.write(`event: done\ndata: ${JSON.stringify({ id: result.id, guardrails: result.guardrails })}\n\n`);
      response.end();
    } catch (error) {
      handleChatError(error, response);
    }
  });
}