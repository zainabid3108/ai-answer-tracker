/** Pure domain types. No framework, queue or database imports allowed in src/domain. */

export type RequestStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface BrandAlias {
  value: string;
  /** Default false (case-insensitive). */
  caseSensitive?: boolean;
}

export interface Brand {
  brandId: string;
  name: string;
  aliases: BrandAlias[];
  /** Phrases that, when they cover a match of this brand, suppress it (e.g. "apple pie" for Apple). */
  exclusions: string[];
}

export interface BrandMention {
  brandId: string;
  name: string;
  count: number;
  /** UTF-16 index of the first match in the (NFC-normalized) answer text. */
  firstPosition: number;
  /** 1-based order of first appearance among mentioned brands. */
  rank: number;
  snippet: string;
}

export interface RawCitation {
  url: string;
  title?: string;
}

export interface Citation {
  position: number;
  rawUrl: string;
  normalizedUrl: string;
  domain: string;
  title?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface AnswerRequest {
  _id: string; // requestId
  tenantId: string;
  idempotencyKey: string;
  questionId: string;
  questionVersion: number;
  questionText: string;
  brands: Brand[]; // snapshot used for deterministic matching
  /** sha256 of the canonical (order-insensitive) brand snapshot; see domain/brands.ts. Legacy rows may lack it. */
  brandsHash?: string;
  providerId: string;
  modelId: string;
  runDate: string; // YYYY-MM-DD (UTC)
  sampleIndex: number;
  status: RequestStatus;
  /** Retryable failures that consumed an attempt. */
  attempts: number;
  /** 429 deferrals that did NOT consume an attempt. */
  rateLimitHits: number;
  errorClass?: string;
  answerId?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  /** BullMQ job id / lock token of the delivery that currently owns a 'running' row. */
  ownerJobId?: string;
  ownerToken?: string;
  /** Bumped each time submit() re-enqueues a stale row under a fresh job id (epoch 0 => jobId = idempotencyKey). */
  enqueueEpoch?: number;
  /** false = failed but the dead-letter entry is not confirmed written yet (recoverable). */
  deadLettered?: boolean;
}

export interface StoredAnswer {
  _id: string; // answerId
  tenantId: string;
  requestId: string;
  providerId: string;
  modelId: string;
  runDate: string;
  text: string;
  usage: Usage;
  latencyMs: number;
  /** True when brand analysis hit a workload cap (answer too long / too many candidate matches). */
  analysisTruncated?: boolean;
  createdAt: Date;
}
