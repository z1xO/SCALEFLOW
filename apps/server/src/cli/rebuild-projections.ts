import { loadConfig } from '../config/env.js';
import { createServices } from '../container.js';
import { loadDotEnv } from '../lib/dotenv.js';
import { Projector } from '../modules/projections/projector.js';

/**
 * Operational repair: recompute read-model status counts from the `jobs` table and move the
 * projector checkpoint to the end of the event log. Briefly blocks job writes (see Projector.rebuildCounts).
 */
loadDotEnv();
const services = createServices(loadConfig(), 'rebuild-projections');
try {
  const result = await new Projector(services.pool, services.logger, services.metrics).rebuildCounts();
  console.log(
    `Rebuilt ${result.projects} (project, status) counts; checkpoint at ${result.checkpoint.txId}.${result.checkpoint.id}`,
  );
} finally {
  await services.close();
}
