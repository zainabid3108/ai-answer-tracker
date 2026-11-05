import { z } from 'zod';

export type ProviderErrorKind =
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'malformed_output'
  | 'content_filtered'
  | 'bad_request'
  | 'auth';

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(['rate_limited', 'server_error', 'timeout']);

/** Normalized provider failure. `kind` is stored on the ledger as the error class. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = RETRYABLE.has(kind);
  }
}

export interface ProviderRequest {
  prompt: string;
  modelId: string;
  /** Idempotency key of the ledger row; adapters may forward it as a provider idempotency header. */
  requestKey: string;
  /** Aborted when the worker-side timeout elapses. */
  signal: AbortSignal;
}

/** Validated shape every adapter must produce. */
export const ProviderResponseSchema = z.object({
  text: z.string().min(1),
  citations: z.array(z.object({ url: z.string().min(1), title: z.string().optional() })).default([]),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }),
});
export type ProviderResponse = z.infer<typeof ProviderResponseSchema>;

/** Adapters return `unknown`; the worker validates it so one bad provider cannot corrupt storage. */
export interface LlmProvider {
  readonly providerId: string;
  generate(req: ProviderRequest): Promise<unknown>;
}

export function parseProviderResponse(raw: unknown): ProviderResponse {
  const r = ProviderResponseSchema.safeParse(raw);
  if (!r.success) throw new ProviderError('malformed_output', 'Provider output failed schema validation');
  return r.data;
}

/** mock = deterministic mock adapters; real = vendor adapters (none implemented in Milestone 1). */
export type ProviderMode = 'mock' | 'real';

/** Config-driven provider/model definition (see registry.ts). */
export const ProviderDefinitionSchema = z.object({
  providerId: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  adapter: z.enum(['mock']),
  enabled: z.boolean().default(true),
  models: z.array(z.string().min(1)).min(1),
});
export type ProviderDefinition = z.infer<typeof ProviderDefinitionSchema>;
