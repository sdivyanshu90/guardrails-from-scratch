import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'packages/core/src/index.ts'
    },
    outDir: 'dist/core',
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    target: 'node20'
  },
  {
    entry: {
      server: 'packages/api/src/server.ts'
    },
    outDir: 'dist/api',
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: false,
    bundle: true,
    noExternal: [/^@guardrails\/core$/],
    target: 'node20'
  }
]);