import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Loads `.env` for local development using Node's built-in parser. Looks in the current directory
 * and the repository root. Real environment variables always win (Node does not overwrite them).
 */
export function loadDotEnv(): void {
  for (const candidate of [path.resolve('.env'), path.resolve('../../.env')]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}
