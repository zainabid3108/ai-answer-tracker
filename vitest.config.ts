import { defineConfig } from 'vitest/config';

// NOTE (Windows): run vitest from a shell whose cwd uses an UPPERCASE drive letter (F:\...).
// With a lowercase "f:\..." cwd vitest 5.1 registers modules twice and every suite fails with
// "Cannot read properties of undefined (reading 'config')".
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { NODE_ENV: 'test' }, // NODE_ENV has no default in loadEnv(); tests must set it explicitly
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000, // first run may download a mongod binary for mongodb-memory-server
    fileParallelism: false, // integration tests share one Redis; keep deterministic
  },
});
