import type { Config } from '../config/env.js';
import { UnprocessableError } from '../lib/errors.js';
import { cpuHandler, echoHandler, flakyHandler, sleepHandler } from './demo.js';
import type { JobHandler } from './types.js';
import { createWebhookHandler } from './webhook.js';

export class HandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly closers: (() => Promise<void>)[] = [];

  register<P>(handler: JobHandler<P> & { close?: () => Promise<void> }): void {
    if (this.handlers.has(handler.type)) throw new Error(`Duplicate handler type ${handler.type}`);
    this.handlers.set(handler.type, handler);
    if (handler.close) this.closers.push(handler.close.bind(handler));
  }

  get(type: string): JobHandler | undefined {
    return this.handlers.get(type);
  }

  list(): { type: string; description: string; defaultTimeoutMs: number }[] {
    return [...this.handlers.values()].map((h) => ({
      type: h.type,
      description: h.description,
      defaultTimeoutMs: h.defaultTimeoutMs,
    }));
  }

  /** Validates a submission payload and returns the parsed (defaults applied) value. */
  parsePayload(type: string, payload: unknown): { handler: JobHandler; payload: unknown } {
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new UnprocessableError('unknown_job_type', `Unknown job type '${type}'`, {
        knownTypes: [...this.handlers.keys()],
      });
    }
    const parsed = handler.payloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new UnprocessableError('invalid_payload', `Payload is not valid for job type '${type}'`, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return { handler, payload: parsed.data };
  }

  async close(): Promise<void> {
    await Promise.all(this.closers.map((c) => c()));
  }
}

export function createHandlerRegistry(config: Config): HandlerRegistry {
  const registry = new HandlerRegistry();
  registry.register(echoHandler);
  registry.register(sleepHandler);
  registry.register(flakyHandler);
  registry.register(cpuHandler);
  registry.register(
    createWebhookHandler({
      signingSecret: config.WEBHOOK_SIGNING_SECRET,
      allowPrivateNetworks: config.WEBHOOK_ALLOW_PRIVATE_NETWORKS,
      userAgent: `ScaleFlow-Webhook/${config.SERVICE_VERSION}`,
    }),
  );
  return registry;
}
