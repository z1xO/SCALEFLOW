import { pino, type Logger, type LoggerOptions } from 'pino';
import type { Config } from '../config/env.js';

export type { Logger };

/**
 * Paths that must never reach log output. Job payloads and results are not logged at all;
 * these cover request/response objects and anything that looks like a credential.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.key',
  'payload',
  '*.payload',
];

export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'LOG_PRETTY'>, service: string): Logger {
  const options: LoggerOptions = {
    level: config.LOG_LEVEL,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };
  if (config.LOG_PRETTY) {
    return pino({ ...options, transport: { target: 'pino-pretty', options: { singleLine: true } } });
  }
  return pino(options);
}
