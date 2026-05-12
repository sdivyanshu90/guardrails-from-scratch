import type { NextFunction, Request, Response } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

export function rateLimitMiddleware(options?: { windowMs?: number; max?: number }) {
  const windowMs = options?.windowMs ?? 60_000;
  const max = options?.max ?? 120;
  const buckets = new Map<string, Bucket>();

  return (request: Request, response: Response, next: NextFunction): void => {
    const key = request.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
      ?? request.ip
      ?? 'anonymous';
    const now = Date.now();
    const current = buckets.get(key);

    if (!current || now >= current.resetAt) {
      buckets.set(key, {
        count: 1,
        resetAt: now + windowMs
      });
      next();
      return;
    }

    if (current.count >= max) {
      response.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          reason: 'Too many requests'
        }
      });
      return;
    }

    current.count += 1;
    next();
  };
}