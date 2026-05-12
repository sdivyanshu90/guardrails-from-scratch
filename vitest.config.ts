import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/**/tests/**/*.test.ts',
      'tests/**/*.test.ts'
    ],
    coverage: {
      reporter: ['text', 'html']
    }
  },
  resolve: {
    alias: {
      '@guardrails/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@guardrails/core/': new URL('./packages/core/src/', import.meta.url).pathname
    }
  }
});