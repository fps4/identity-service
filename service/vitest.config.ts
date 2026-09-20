import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // A test file talks to DynamoDB Local (tests/helpers/store.ts): every write is a network round trip.
    testTimeout: 20_000,
    hookTimeout: 60_000,
    coverage: {
      reporter: ['text', 'json-summary']
    }
  }
});
