import { performance } from 'node:perf_hooks';

import Ajv from 'ajv';

import type { Guard, GuardConfig, GuardResult, RequestContext } from '../types.js';
import { asRecord, isLikelyEnglish } from '../utils.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const HTML_TAG = /<\/?[a-z][^>]*>/i;

interface ValidationIssue {
  code: string;
  score: number;
  message: string;
}

export class SchemaValidator implements Guard {
  readonly id = 'schema-validator';
  readonly phase = 'output' as const;

  constructor(private readonly config: GuardConfig) {}

  async run(content: string, context: RequestContext): Promise<GuardResult> {
    const startedAt = performance.now();
    const options = asRecord(this.config.options);
    const metadata = asRecord(context.metadata);
    const issues: ValidationIssue[] = [];
    let sanitizedContent = content;

    const maxLength = typeof options.max_length_chars === 'number' ? options.max_length_chars : Number.POSITIVE_INFINITY;
    const minLength = typeof options.min_length_chars === 'number' ? options.min_length_chars : 0;
    const overflowAction = options.overflow_action === 'error' ? 'error' : 'truncate';

    if (content.length > maxLength) {
      if (overflowAction === 'error') {
        issues.push({
          code: 'MAX_LENGTH_CHARS',
          score: 0.8,
          message: `Response exceeds maximum length of ${maxLength} characters`
        });
      } else {
        sanitizedContent = `${content.slice(0, Math.max(0, maxLength - 16)).trimEnd()} [...truncated]`;
        issues.push({
          code: 'MAX_LENGTH_CHARS',
          score: 0.45,
          message: `Response truncated to ${maxLength} characters`
        });
      }
    }

    if (content.trim().length < minLength) {
      issues.push({
        code: 'MIN_LENGTH_CHARS',
        score: 0.2,
        message: `Response shorter than minimum length of ${minLength} characters`
      });
    }

    const schema = metadata.jsonSchema ?? options.json_schema;
    if (schema) {
      try {
        const parsed = JSON.parse(content);
        const validator = ajv.compile(schema as object);
        if (!validator(parsed)) {
          issues.push({
            code: 'JSON_SCHEMA',
            score: 0.8,
            message: ajv.errorsText(validator.errors) || 'JSON schema validation failed'
          });
        }
      } catch (error) {
        issues.push({
          code: 'JSON_SCHEMA',
          score: 0.8,
          message: error instanceof Error ? error.message : 'Invalid JSON response'
        });
      }
    }

    if (options.language_match === true) {
      const inputContent = typeof metadata.inputContent === 'string' ? metadata.inputContent : '';
      if (isLikelyEnglish(inputContent) && !isLikelyEnglish(content)) {
        issues.push({
          code: 'LANGUAGE_MATCH',
          score: 0.5,
          message: 'Response language does not match the detected input language'
        });
      }
    }

    const formatRules = asRecord(options.format_rules);
    const plainTextMode = formatRules.mode === 'plain-text' || formatRules.no_raw_html === true;
    if (plainTextMode && HTML_TAG.test(content)) {
      issues.push({
        code: 'FORMAT_RULES',
        score: 0.6,
        message: 'Raw HTML is not allowed in plain-text mode'
      });
    }

    const durationMs = Number((performance.now() - startedAt).toFixed(3));
    if (issues.length === 0) {
      return {
        guardId: this.id,
        verdict: 'pass',
        score: 0,
        durationMs
      };
    }

    const score = Math.min(1, issues.reduce((sum, issue) => sum + issue.score, 0));
    const verdict = sanitizedContent !== content ? 'redact' : score >= 0.5 ? 'warn' : 'pass';
    return {
      guardId: this.id,
      verdict,
      score: Number(score.toFixed(3)),
      reason: issues.map((issue) => issue.code).join(', '),
      metadata: {
        validationIssues: issues,
        ...(sanitizedContent !== content ? { sanitizedContent } : {})
      },
      durationMs
    };
  }
}