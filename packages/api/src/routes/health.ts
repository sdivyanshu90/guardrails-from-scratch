import type { Express, Request, Response } from 'express';

import type { GuardrailsEngine } from '@guardrails/core';

export function registerHealthRoutes(app: Express, engine: GuardrailsEngine, startedAt = Date.now()): void {
  app.get('/health', (_request: Request, response: Response) => {
    response.status(200).json({
      status: 'ok',
      uptimeSec: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
      configLoaded: true,
      adapters: ['openai', 'anthropic', 'ollama'].filter((provider) => engine.getAdapter(provider))
    });
  });

  app.get('/metrics', async (_request: Request, response: Response) => {
    response.setHeader('Content-Type', engine.metrics.registry.contentType);
    response.status(200).send(await engine.metrics.metrics());
  });
}