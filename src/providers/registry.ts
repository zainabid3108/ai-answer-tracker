import { MockProvider } from './mockProvider.js';
import { ProviderDefinitionSchema, type LlmProvider, type ProviderDefinition, type ProviderMode } from './types.js';

/** Default definitions (config data, not logic). Replace/extend without touching worker or API code. */
export const DEFAULT_PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  { providerId: 'mock-alpha', adapter: 'mock', enabled: true, models: ['mock-alpha-1'] },
  { providerId: 'mock-beta', adapter: 'mock', enabled: true, models: ['mock-beta-1', 'mock-beta-2'] },
];

export interface ResolvedTarget {
  providerId: string;
  modelId: string;
}

export class ProviderRegistry {
  private readonly defs = new Map<string, ProviderDefinition>();
  private readonly providers = new Map<string, LlmProvider>();

  constructor(definitions: ProviderDefinition[], factory: (def: ProviderDefinition) => LlmProvider) {
    for (const raw of definitions) {
      const def = ProviderDefinitionSchema.parse(raw);
      if (this.defs.has(def.providerId)) throw new Error(`Duplicate providerId ${def.providerId}`);
      this.defs.set(def.providerId, def);
      this.providers.set(def.providerId, factory(def));
    }
  }

  /** Providers whose queues should exist (enabled only). */
  listEnabled(): ProviderDefinition[] {
    return [...this.defs.values()].filter((d) => d.enabled);
  }

  /** One target per enabled provider/model (default fan-out). */
  allTargets(): ResolvedTarget[] {
    return this.listEnabled().flatMap((d) => d.models.map((modelId) => ({ providerId: d.providerId, modelId })));
  }

  /**
   * Resolve an optional (providerId, modelId) selection into concrete targets.
   * Returns null if the selection is unknown or disabled.
   */
  resolve(providerId?: string, modelId?: string): ResolvedTarget[] | null {
    if (!providerId) return modelId ? null : this.allTargets();
    const def = this.defs.get(providerId);
    if (!def || !def.enabled) return null;
    if (modelId) return def.models.includes(modelId) ? [{ providerId, modelId }] : null;
    return def.models.map((m) => ({ providerId, modelId: m }));
  }

  getProvider(providerId: string): LlmProvider | undefined {
    return this.providers.get(providerId);
  }
}

/**
 * Definitions for real vendor adapters. Intentionally empty in Milestone 1: PROVIDER_MODE=real therefore
 * fails fast at startup instead of silently serving mock answers.
 */
export const REAL_PROVIDER_DEFINITIONS: ProviderDefinition[] = [];

export function createProviderRegistry(
  opts: { definitions?: ProviderDefinition[]; allowFailureInjection?: boolean; mode?: ProviderMode } = {},
): ProviderRegistry {
  const mode = opts.mode ?? 'mock';
  const definitions = opts.definitions ?? (mode === 'real' ? REAL_PROVIDER_DEFINITIONS : DEFAULT_PROVIDER_DEFINITIONS);
  if (mode === 'real') {
    if (definitions.some((d) => d.adapter === 'mock')) {
      throw new Error('PROVIDER_MODE=real but a mock adapter is configured; refusing to start');
    }
    if (!definitions.some((d) => d.enabled)) {
      throw new Error('PROVIDER_MODE=real but no real provider adapters are registered (this build ships mock adapters only); refusing to start');
    }
  }
  return new ProviderRegistry(definitions, (def) => {
    switch (def.adapter) {
      case 'mock':
        // Failure-injection directives are OFF unless explicitly enabled by the caller.
        return new MockProvider(def.providerId, { allowFailureInjection: opts.allowFailureInjection === true });
    }
  });
}
