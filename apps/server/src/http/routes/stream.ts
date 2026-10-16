import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from '../../container.js';
import { TooManyRequestsError } from '../../lib/errors.js';
import { formatCursor, parseCursor, type EventCursor } from '../../modules/events/event-log.js';
import type { JobEventDto } from '../../modules/jobs/model.js';
import { compareCursors, type RealtimeHub } from '../../modules/realtime/hub.js';
import { authorizeProject } from '../auth.js';
import { errorResponses, IdParam } from '../schemas.js';

/** Writes beyond this many buffered bytes mean the client cannot keep up; it is disconnected and will replay on reconnect. */
const MAX_BUFFERED_BYTES = 1_048_576;

export const streamRoutes =
  (services: Services, hub: RealtimeHub): FastifyPluginCallbackZod =>
  (app, _opts, done) => {
    app.get(
      '/v1/projects/:projectId/stream',
      {
        schema: {
          tags: ['events'],
          summary: 'Server-Sent Events stream of job events for one project',
          description:
            'Events: `job` (id = commit-ordered cursor), `system` (queue/worker snapshot every few seconds, no id), ' +
            '`ready` (sent after replay; carries the current cursor), `reset` (the client was too far behind: re-fetch ' +
            'state). Reconnect with `Last-Event-ID` (browsers do this automatically) or `?since=<cursor>` to resume ' +
            'without gaps or duplicates.',
          params: IdParam,
          querystring: z.object({ since: z.string().max(64).optional() }),
          headers: z.object({ 'last-event-id': z.string().max(64).optional() }),
          response: { 200: z.string().describe('text/event-stream'), ...errorResponses },
        },
      },
      async (request, reply) => {
        const { projectId } = request.params;
        const { principal } = await authorizeProject(services, request, projectId, 'jobs:read');
        await hub.start();

        const rawCursor = request.headers['last-event-id'] ?? request.query.since;
        const resumeFrom = parseCursor(rawCursor);
        const invalidCursor = rawCursor !== undefined && resumeFrom === null;
        const principalKey =
          principal.kind === 'user' ? `user:${principal.userId}` : `key:${principal.apiKeyId}`;
        const raw = reply.raw;
        const log = request.log.child({ projectId, stream: true });

        let replaying = true;
        const buffered: JobEventDto[] = [];
        let lastSent: EventCursor = resumeFrom ?? hub.position;

        const write = (chunk: string): void => {
          if (raw.writableEnded || raw.destroyed) return;
          raw.write(chunk);
          if (raw.writableLength > MAX_BUFFERED_BYTES) {
            log.warn({ buffered: raw.writableLength }, 'slow SSE consumer disconnected');
            raw.destroy();
          }
        };
        const sendEvent = (e: JobEventDto): void => {
          const c = parseCursor(e.cursor);
          if (!c || compareCursors(c, lastSent) <= 0) return; // already delivered (replay/live overlap)
          lastSent = c;
          services.metrics.realtimeEventsSent.inc();
          write(`id: ${e.cursor}\nevent: job\ndata: ${JSON.stringify(e)}\n\n`);
        };

        // Subscribe before replaying so nothing committed in between is missed; live events are
        // buffered until the replay is written, then flushed with de-duplication by cursor.
        const unsubscribe = hub.subscribe({
          projectId,
          principalKey,
          onEvent: (e) => {
            if (replaying) buffered.push(e);
            else sendEvent(e);
          },
          onSystem: (s) => {
            write(`event: system\ndata: ${JSON.stringify(s)}\n\n`);
          },
          close: () => {
            if (!raw.writableEnded) raw.end();
          },
        });
        if (!unsubscribe) {
          throw new TooManyRequestsError(
            'too_many_streams',
            'Too many open event streams for this principal',
            5,
          );
        }

        reply.hijack();
        raw.writeHead(200, {
          ...(reply.getHeaders() as Record<string, string>),
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no', // disable proxy buffering (nginx)
        });
        write('retry: 3000\n\n');

        const heartbeat = setInterval(() => {
          write(': ping\n\n');
        }, services.config.SSE_HEARTBEAT_MS);
        const cleanup = (): void => {
          clearInterval(heartbeat);
          unsubscribe();
        };
        raw.on('close', cleanup);

        try {
          if (invalidCursor) {
            lastSent = hub.position;
            write(`event: reset\ndata: ${JSON.stringify({ reason: 'invalid_cursor' })}\n\n`);
          } else if (resumeFrom) {
            const events = await hub.replay(projectId, resumeFrom, services.config.SSE_REPLAY_MAX_EVENTS);
            if (events === null) {
              lastSent = hub.position;
              write(`event: reset\ndata: ${JSON.stringify({ reason: 'too_far_behind' })}\n\n`);
            } else {
              for (const e of events) sendEvent(e);
            }
          }
          write(
            `id: ${formatCursor(lastSent)}\nevent: ready\ndata: ${JSON.stringify({ cursor: formatCursor(lastSent) })}\n\n`,
          );
          replaying = false;
          for (const e of buffered.splice(0)) sendEvent(e);
        } catch (err) {
          log.error({ err }, 'SSE replay failed; closing stream');
          cleanup();
          raw.destroy();
        }
      },
    );
    done();
  };
