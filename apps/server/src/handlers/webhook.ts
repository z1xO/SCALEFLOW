import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { Agent, request, type Dispatcher } from 'undici';
import { z } from 'zod';
import { guardedLookup, isBlockedAddress } from './network-guard.js';
import { PermanentJobError, RetryableJobError, type JobHandler } from './types.js';

const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'proxy-authorization',
  'scaleflow-signature',
  'scaleflow-timestamp',
  'scaleflow-job-id',
  'scaleflow-attempt',
  'idempotency-key',
]);

export const WebhookPayload = z.object({
  url: z
    .url()
    .max(2048)
    .refine((u) => /^https?:\/\//i.test(u), { message: 'Only http(s) URLs are allowed' }),
  method: z.enum(['POST', 'PUT', 'PATCH']).default('POST'),
  headers: z
    .record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(1024))
    .refine((h) => Object.keys(h).length <= 20, { message: 'At most 20 headers' })
    .refine((h) => Object.keys(h).every((k) => !RESERVED_HEADERS.has(k.toLowerCase())), {
      message: 'Reserved header',
    })
    .default({}),
  body: z.unknown(),
});
export type WebhookPayload = z.infer<typeof WebhookPayload>;

export interface WebhookOptions {
  signingSecret: string;
  allowPrivateNetworks: boolean;
  userAgent: string;
}

/**
 * Delivers an HTTP request ("event delivery"). Signs the body with HMAC-SHA256 over
 * `<timestamp>.<body>`, sends a stable Idempotency-Key (the job id) so receivers can deduplicate
 * the at-least-once deliveries, and classifies failures:
 *   2xx -> success; 408/429/5xx/network/timeout -> retry; other 4xx -> permanent failure.
 */
export function createWebhookHandler(opts: WebhookOptions): JobHandler<WebhookPayload> & { close(): Promise<void> } {
  const dispatcher: Dispatcher = new Agent({
    connections: 64,
    keepAliveTimeout: 10_000,
    connect: opts.allowPrivateNetworks ? {} : { lookup: guardedLookup },
  });

  return {
    type: 'webhook.deliver',
    description: 'Delivers a signed HTTP request to a URL, retrying on 5xx/429/timeouts.',
    payloadSchema: WebhookPayload,
    defaultTimeoutMs: 15_000,
    async close() {
      await dispatcher.close();
    },
    async execute(payload, ctx) {
      const url = new URL(payload.url);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      // IP literals bypass DNS lookup, so check them directly.
      if (!opts.allowPrivateNetworks && isIP(host) && isBlockedAddress(host)) {
        throw new PermanentJobError('destination_blocked', `Destination ${host} is a private or reserved address`);
      }
      const body = JSON.stringify(payload.body ?? null);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = createHmac('sha256', opts.signingSecret).update(`${timestamp}.${body}`).digest('hex');
      const started = Date.now();
      let res: Dispatcher.ResponseData;
      try {
        res = await request(url, {
          method: payload.method,
          dispatcher,
          signal: ctx.signal,
          headersTimeout: 10_000,
          bodyTimeout: 10_000,
          headers: {
            ...payload.headers,
            'content-type': 'application/json',
            'user-agent': opts.userAgent,
            'idempotency-key': ctx.jobId,
            'scaleflow-job-id': ctx.jobId,
            'scaleflow-attempt': String(ctx.attempt),
            'scaleflow-timestamp': timestamp,
            'scaleflow-signature': `v1=${signature}`,
          },
          body,
        });
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'EBLOCKED') {
          throw new PermanentJobError('destination_blocked', err.message);
        }
        if (ctx.signal.aborted) throw err;
        throw new RetryableJobError('network_error', err instanceof Error ? err.message : String(err));
      }
      const text = await res.body.text();
      const snippet = text.slice(0, 500);
      const durationMs = Date.now() - started;
      if (res.statusCode >= 200 && res.statusCode < 300) {
        return { status: res.statusCode, durationMs, responseSnippet: snippet };
      }
      const msg = `Target responded ${res.statusCode}${snippet ? `: ${snippet}` : ''}`;
      if (res.statusCode === 408 || res.statusCode === 429 || res.statusCode >= 500) {
        throw new RetryableJobError(`http_${res.statusCode}`, msg);
      }
      throw new PermanentJobError(`http_${res.statusCode}`, msg);
    },
  };
}
