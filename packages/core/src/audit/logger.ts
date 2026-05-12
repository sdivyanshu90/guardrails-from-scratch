import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import pino from 'pino';

import type { AuditEntry, GuardrailConfig } from '../types.js';

export class AuditLogger {
  private readonly logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

  constructor(private readonly config: GuardrailConfig['audit']) {}

  async log(entry: AuditEntry): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    switch (this.config.destination) {
      case 'console': {
        this.logger.info(entry, 'guardrail_audit');
        return;
      }
      case 'file': {
        if (!this.config.filePath) {
          this.logger.warn({ entry }, 'audit destination=file but filePath is missing');
          return;
        }

        await mkdir(dirname(this.config.filePath), { recursive: true });
        await appendFile(this.config.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
        return;
      }
      case 'http': {
        if (!this.config.httpEndpoint) {
          this.logger.warn({ entry }, 'audit destination=http but httpEndpoint is missing');
          return;
        }

        await fetch(this.config.httpEndpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify(entry)
        });
      }
    }
  }

  async query(page = 1, pageSize = 20): Promise<{ data: AuditEntry[]; total: number }> {
    if (this.config.destination !== 'file' || !this.config.filePath) {
      return { data: [], total: 0 };
    }

    try {
      const contents = await readFile(this.config.filePath, 'utf8');
      const entries = contents
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AuditEntry)
        .reverse();

      const start = (page - 1) * pageSize;
      return {
        data: entries.slice(start, start + pageSize),
        total: entries.length
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { data: [], total: 0 };
      }

      throw error;
    }
  }
}