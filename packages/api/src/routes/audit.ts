import type { Express, Request, Response } from 'express';

import type { GuardrailsEngine } from '@guardrails/core';

export function registerAuditRoutes(app: Express, engine: GuardrailsEngine): void {
  app.get('/v1/audit', async (request: Request, response: Response) => {
    const page = Number(request.query.page ?? 1);
    const pageSize = Number(request.query.pageSize ?? 20);
    const result = await engine.auditLogger.query(page, pageSize);
    response.status(200).json({
      page,
      pageSize,
      total: result.total,
      data: result.data
    });
  });
}