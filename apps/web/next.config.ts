import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Next only reads .env files from apps/web; the repo keeps one .env at the root.
try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'));
} catch {
  // No root .env: use the real environment only.
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source; let Next compile them.
  transpilePackages: ['@cue/db', '@cue/shared', '@cue/storage'],
  // Keep every page out of search indexes (robots.txt says the same).
  headers: () =>
    Promise.resolve([
      { source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] },
    ]),
};

export default nextConfig;
