import type { NextConfig } from 'next';

// Next only reads .env files from apps/web; the repo keeps one .env at the root.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // No root .env: use the real environment only.
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source; let Next compile them.
  transpilePackages: ['@cue/db', '@cue/shared'],
};

export default nextConfig;
