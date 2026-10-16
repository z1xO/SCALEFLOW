import { createServer, type Server } from 'node:http';

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
import type { Services } from '../container.js';
import { checkDependencies } from './health.js';

/**
 * Minimal HTTP server for non-API processes (worker, relay, scheduler): Prometheus scraping plus
 * liveness/readiness probes for the orchestrator.
 */
export function startOpsServer(
  services: Services,
  port: number,
  isShuttingDown: () => boolean,
): Promise<Server> {
  const { metrics, config, logger } = services;
  const server = createServer((req, res) => {
    const send = (status: number, body: string, type = 'application/json'): void => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    const handle = async (): Promise<void> => {
      switch (req.url) {
        case '/healthz':
          send(200, '{"status":"ok"}');
          return;
        case '/readyz': {
          if (isShuttingDown()) {
            send(503, '{"status":"shutting_down"}');
            return;
          }
          const r = await checkDependencies(services.pool, services.redis);
          send(r.ok ? 200 : 503, JSON.stringify({ status: r.ok ? 'ready' : 'not_ready', checks: r.checks }));
          return;
        }
        case '/metrics':
          if (config.METRICS_TOKEN && req.headers.authorization !== `Bearer ${config.METRICS_TOKEN}`) {
            send(401, '{"status":"unauthorized"}');
            return;
          }
          send(200, await metrics.registry.metrics(), metrics.registry.contentType);
          return;
        default:
          send(404, '{"status":"not_found"}');
      }
    };
    handle().catch((err: unknown) => {
      logger.error({ err }, 'ops server request failed');
      send(500, '{"status":"error"}');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      logger.info({ port }, 'ops server listening');
      resolve(server);
    });
  });
}
