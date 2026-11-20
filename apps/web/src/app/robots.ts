import type { MetadataRoute } from 'next';

/**
 * Nothing here is for search engines: everything is behind sign-in, and the
 * call library includes transcripts that must not be indexed. Also sent as an
 * X-Robots-Tag header on every response (next.config.ts).
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', disallow: '/' } };
}
