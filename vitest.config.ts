import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/cluster.ts'],
    },
    testTimeout: 30_000,      // testcontainers can be slow to start
    hookTimeout: 60_000,
    pool: 'forks',            // required for testcontainers
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
