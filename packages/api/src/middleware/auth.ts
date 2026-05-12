import type { NextFunction, Request, Response } from 'express';

export function authMiddleware(expectedToken?: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!expectedToken) {
      next();
      return;
    }

    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;

    if (token !== expectedToken) {
      response.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          reason: 'Missing or invalid bearer token'
        }
      });
      return;
    }

    next();
  };
}