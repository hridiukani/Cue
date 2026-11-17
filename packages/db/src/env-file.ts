import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load the repo-root .env into process.env if it exists. Real env vars win.
 *
 * For Node-run scripts and tests only (drizzle-kit, db:migrate, db:seed,
 * vitest). Deliberately NOT exported from the package's main entry, and the
 * path is built with path.join rather than `new URL('…', import.meta.url)`:
 * bundlers treat that pattern as an asset and would copy .env into the build.
 */
export function loadRootEnvFile(): void {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  try {
    process.loadEnvFile(path.join(repoRoot, '.env'));
  } catch {
    // No .env file: use the real environment only.
  }
}
