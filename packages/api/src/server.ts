import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import express, { type Express } from 'express';

import {
  AnthropicAdapter,
  ConfigManager,
  GuardrailsEngine,
  OllamaAdapter,
  OpenAIAdapter
} from '@guardrails/core';

import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerRuleRoutes } from './routes/rules.js';

export interface AppServices {
  engine: GuardrailsEngine;
  configManager: ConfigManager;
}

export interface AppOptions {
  authToken?: string;
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
}

export async function createServices(configPath = resolve(process.cwd(), process.env.GUARDRAILS_CONFIG ?? 'config/rules.default.yaml')): Promise<AppServices> {
  const configManager = await ConfigManager.fromFile(configPath);
  configManager.watch();
  const engine = new GuardrailsEngine(configManager.getConfig());

  configManager.onChange((nextConfig) => {
    engine.updateConfig(nextConfig);
  });

  if (process.env.OPENAI_API_KEY) {
    engine.registerAdapter('openai', new OpenAIAdapter(process.env.OPENAI_API_KEY));
  }

  if (process.env.ANTHROPIC_API_KEY) {
    engine.registerAdapter('anthropic', new AnthropicAdapter(process.env.ANTHROPIC_API_KEY));
  }

  engine.registerAdapter('ollama', new OllamaAdapter({
    baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
  }));

  return {
    engine,
    configManager
  };
}

export function createApp(services: AppServices, options: AppOptions = {}): Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(authMiddleware(options.authToken));
  app.use(rateLimitMiddleware({
    ...(options.rateLimitWindowMs !== undefined ? { windowMs: options.rateLimitWindowMs } : {}),
    ...(options.rateLimitMax !== undefined ? { max: options.rateLimitMax } : {})
  }));

  registerChatRoutes(app, services.engine);
  registerRuleRoutes(app, services.configManager, services.engine);
  registerAuditRoutes(app, services.engine);
  registerHealthRoutes(app, services.engine);

  return app;
}

export async function startServer(): Promise<void> {
  const services = await createServices();
  const app = createApp(services, {
    ...(process.env.API_AUTH_TOKEN ? { authToken: process.env.API_AUTH_TOKEN } : {}),
    ...(process.env.RATE_LIMIT_WINDOW_MS ? { rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) } : {}),
    ...(process.env.RATE_LIMIT_MAX ? { rateLimitMax: Number(process.env.RATE_LIMIT_MAX) } : {})
  });

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  app.listen(port, () => {
    process.stdout.write(`Guardrails API listening on :${port}\n`);
  });
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  void startServer();
}