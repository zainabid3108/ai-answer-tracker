import { parseApiKeys, type Env } from './env.js';
import type { BrandLimits } from '../domain/brands.js';
import type { Logger } from '../observability/logger.js';
import { createProviderRegistry, type ProviderRegistry } from '../providers/registry.js';

/** Raised for unsafe/invalid runtime configuration. Messages name variables, never values. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Refusing to start: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

export type ProcessRole = 'api' | 'worker';

export const PRODUCTION_MIN_API_KEY_LENGTH = 32;

export interface RuntimeConfig {
  isProduction: boolean;
  /** Empty for the worker role (it does not authenticate callers). */
  apiKeys: Array<[string, string]>;
  /** Effective flag handed to the provider registry: mock mode AND explicitly enabled AND not production. */
  allowFailureInjection: boolean;
  /** Non-fatal but important notices; callers log them at warn level. */
  warnings: string[];
}

/**
 * Single source of truth for startup safety checks, shared by src/server.ts (role 'api') and
 * src/worker.ts (role 'worker'). Provider/mock/injection rules apply to both roles; API_KEYS rules apply
 * to the API role only because workers never authenticate callers.
 */
export function validateRuntime(env: Env, role: ProcessRole): RuntimeConfig {
  const isProduction = env.NODE_ENV === 'production';
  const problems: string[] = [];
  const warnings: string[] = [];

  if (env.PROVIDER_MODE === 'mock' && isProduction) {
    if (!env.ALLOW_MOCK_IN_PRODUCTION) {
      problems.push('PROVIDER_MODE=mock is not allowed with NODE_ENV=production (use PROVIDER_MODE=real, or set ALLOW_MOCK_IN_PRODUCTION=true for a deliberate non-customer deployment)');
    } else {
      warnings.push('SECURITY WARNING: mock AI providers are running with NODE_ENV=production because ALLOW_MOCK_IN_PRODUCTION=true. Answers are FAKE.');
    }
  }
  if (env.ENABLE_MOCK_FAILURE_INJECTION && isProduction) {
    problems.push('ENABLE_MOCK_FAILURE_INJECTION=true is never allowed with NODE_ENV=production');
  }
  if (env.ENABLE_MOCK_FAILURE_INJECTION && env.PROVIDER_MODE === 'real') {
    warnings.push('ENABLE_MOCK_FAILURE_INJECTION is ignored when PROVIDER_MODE=real');
  }

  let apiKeys: Array<[string, string]> = [];
  if (role === 'api') {
    let keysInvalid = false;
    try {
      apiKeys = parseApiKeys(env.API_KEYS, { minKeyLength: isProduction ? PRODUCTION_MIN_API_KEY_LENGTH : 1 });
    } catch (err) {
      keysInvalid = true;
      problems.push((err as Error).message); // already value-free
    }
    if (!keysInvalid && apiKeys.length === 0) {
      if (isProduction) problems.push('API_KEYS must contain at least one apiKey:tenantId entry in production');
      else warnings.push('API_KEYS is empty: every authenticated request will be rejected');
    }
  }

  if (problems.length) throw new ConfigError(problems);
  return {
    isProduction,
    apiKeys,
    allowFailureInjection: env.PROVIDER_MODE === 'mock' && env.ENABLE_MOCK_FAILURE_INJECTION && !isProduction,
    warnings,
  };
}

/** Validate, log warnings, and build the provider registry. Throws ConfigError / Error (no secrets) on failure. */
export function bootstrapRuntime(env: Env, role: ProcessRole, logger?: Logger): { config: RuntimeConfig; registry: ProviderRegistry } {
  const config = validateRuntime(env, role);
  for (const w of config.warnings) logger?.warn({ role }, w);
  const registry = createProviderRegistry({ mode: env.PROVIDER_MODE, allowFailureInjection: config.allowFailureInjection });
  return { config, registry };
}

export function brandLimitsFromEnv(env: Env): BrandLimits {
  return {
    maxBrands: env.MAX_BRANDS,
    maxAliasesPerBrand: env.MAX_ALIASES_PER_BRAND,
    maxTotalAliases: env.MAX_TOTAL_ALIASES,
    minAliasLength: 2,
    maxAliasLength: 100,
    maxNameLength: 200,
    maxExclusionsPerBrand: 50,
    maxTotalExclusions: 500,
  };
}
