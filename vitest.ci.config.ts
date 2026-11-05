import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

// CI profile: Redis-backed integration suites must FAIL (not skip) when Redis is unreachable.
// Set via vitest `test.env` so it works on every OS without cross-env.
export default mergeConfig(base, defineConfig({ test: { env: { REQUIRE_REDIS: 'true' } } }));
