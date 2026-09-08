import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    env: { DATA_DIR: '/tmp/boogle-test-data', AUTH_MODE: 'none', SEARXNG_URL: 'http://127.0.0.1:1' },
  },
});
