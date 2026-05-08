import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 10_000,
    setupFiles: ['./test/setup.ts'],
  },
  esbuild: {
    target: 'es2022',
  },
});
