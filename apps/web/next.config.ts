import type { NextConfig } from 'next';

// Next only reads .env files from apps/web; the repo keeps one .env at the root.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // No root .env: use the real environment only.
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
