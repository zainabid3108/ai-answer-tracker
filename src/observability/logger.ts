import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

/**
 * Structured JSON logger. Convention: log IDs, statuses and error classes only - never question text,
 * answer bodies, URLs with credentials or secrets. Redaction is a safety net, not a licence to log them.
 */
export const REDACT_PATHS = [
  'apiKey',
  'password',
  'token',
  'authorization',
  'mongoUrl',
  'redisUrl',
  'questionText',
  'question',
  'answerText',
  'text',
  '*.apiKey',
  '*.password',
  '*.token',
  '*.authorization',
  '*.mongoUrl',
  '*.redisUrl',
  '*.questionText',
  '*.question',
  '*.answerText',
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'headers.authorization',
  'headers["x-api-key"]',
];

export function createLogger(level = 'info', destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: undefined,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}
