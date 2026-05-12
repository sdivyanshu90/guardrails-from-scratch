import type { Express, Request, Response } from 'express';
import { z } from 'zod';

import type { ConfigManager, GuardrailsEngine } from '@guardrails/core';

const ruleUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  weight: z.number().min(0).max(1).optional(),
  options: z.record(z.unknown()).optional()
});

export function registerRuleRoutes(app: Express, configManager: ConfigManager, engine: GuardrailsEngine): void {
  app.get('/v1/rules', (_request: Request, response: Response) => {
    response.status(200).json({
      rules: configManager.listRules()
    });
  });

  app.put('/v1/rules/:id', async (request: Request, response: Response) => {
    try {
      const parsedUpdate = ruleUpdateSchema.parse(request.body);
      const update = {
        ...(parsedUpdate.enabled !== undefined ? { enabled: parsedUpdate.enabled } : {}),
        ...(parsedUpdate.weight !== undefined ? { weight: parsedUpdate.weight } : {}),
        ...(parsedUpdate.options ? { options: parsedUpdate.options } : {})
      };
      const ruleId = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
      if (!ruleId) {
        response.status(400).json({
          error: {
            code: 'INVALID_RULE_ID',
            reason: 'Rule id is required'
          }
        });
        return;
      }

      const updated = await configManager.updateRule(ruleId, update);

      if (!updated) {
        response.status(404).json({
          error: {
            code: 'RULE_NOT_FOUND',
            reason: `Rule ${ruleId} was not found`
          }
        });
        return;
      }

      engine.updateConfig(configManager.getConfig());
      response.status(200).json({
        rule: updated
      });
    } catch (error) {
      response.status(400).json({
        error: {
          code: 'INVALID_RULE_UPDATE',
          reason: error instanceof Error ? error.message : 'Invalid rule update payload'
        }
      });
    }
  });
}