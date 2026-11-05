import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    testTimeout: 15_000,
    coverage: { include: ['src/**/*.ts'], exclude: ['src/cli.ts', 'src/commands/**'] },
  },
});
