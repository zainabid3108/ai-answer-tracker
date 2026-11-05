import { Queue, type ConnectionOptions } from 'bullmq';
import { z } from 'zod';

/**
 * Per-provider queues. BullMQ forbids ':' in queue names and custom job ids, so the planned
 * "llm:<providerId>" is spelled "llm-<providerId>" (documented deviation).
 */
export const llmQueueName = (providerId: string) => `llm-${providerId}`;
export const DLQ_NAME = 'llm-dlq';

export const LlmJobDataSchema = z.object({ tenantId: z.string().min(1), requestId: z.string().min(1) });
export type LlmJobData = z.infer<typeof LlmJobDataSchema>;

export interface DeadLetterPayload {
  tenantId: string;
  requestId: string;
  providerId: string;
  errorClass: string;
  attempts: number;
}

/** Port used by the API/service to enqueue work. */
export interface JobEnqueuer {
  /** `jobId` MUST be the idempotency hash: enqueuing the same id twice is a no-op. */
  enqueue(job: { providerId: string; jobId: string } & LlmJobData): Promise<void>;
}

/** Port used by the worker to park exhausted/non-retryable jobs. */
export interface DeadLetterSink {
  deadLetter(jobId: string, payload: DeadLetterPayload): Promise<void>;
}

export function parseRedisUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  const opts: Record<string, unknown> = {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
  };
  if (u.username) opts.username = decodeURIComponent(u.username);
  if (u.password) opts.password = decodeURIComponent(u.password);
  if (u.pathname.length > 1) opts.db = Number(u.pathname.slice(1));
  if (u.protocol === 'rediss:') opts.tls = {};
  return opts as ConnectionOptions;
}

export interface QueueManagerOptions {
  connection: ConnectionOptions;
  prefix: string;
  maxAttempts: number;
  backoffBaseMs: number;
}

export class QueueManager implements JobEnqueuer, DeadLetterSink {
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly opts: QueueManagerOptions) {}

  queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.opts.connection, prefix: this.opts.prefix });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue(job: { providerId: string; jobId: string } & LlmJobData): Promise<void> {
    const data: LlmJobData = { tenantId: job.tenantId, requestId: job.requestId };
    await this.queue(llmQueueName(job.providerId)).add('generate', data, {
      jobId: job.jobId,
      attempts: this.opts.maxAttempts,
      backoff: { type: 'expJitter', delay: this.opts.backoffBaseMs },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  }

  async deadLetter(jobId: string, payload: DeadLetterPayload): Promise<void> {
    // Same jobId => repeated parking of the same request is a no-op.
    await this.queue(DLQ_NAME).add('dead', payload, { jobId, removeOnComplete: false, removeOnFail: false });
  }

  async ping(): Promise<void> {
    // Cheap round trip to Redis through BullMQ's own connection.
    await this.queue(DLQ_NAME).getJobCounts('waiting');
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}
