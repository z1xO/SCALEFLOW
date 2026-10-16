import { loadConfig } from '../config/env.js';
import { createServices } from '../container.js';
import { buildApp } from '../http/app.js';
import { loadDotEnv } from '../lib/dotenv.js';
import { Lifecycle } from '../lib/lifecycle.js';

loadDotEnv();
const config = loadConfig();
const services = createServices(config, 'api');
const lifecycle = new Lifecycle(services.logger);
lifecycle.installSignalHandlers();
lifecycle.onShutdown('services', () => services.close());

const app = await buildApp(services, { isShuttingDown: () => lifecycle.isShuttingDown });
// Registered last so it runs first: stop accepting connections and finish in-flight requests.
lifecycle.onShutdown('http', () => app.close());

await app.listen({ host: config.API_HOST, port: config.API_PORT });
services.logger.info({ port: config.API_PORT }, 'api listening');
