import type { AdapterKey } from './types';

/**
 * Datasets that may only be imported into a database on this machine.
 *
 * liva-ai/real-sales has no stated license, so its transcripts must never be
 * shown to anyone else. A deployed app's GitHub sign-in is open to anyone
 * with a GitHub account, so "behind sign-in" is not enough there: it stays
 * out of the deployed database entirely (docs/deploy.md).
 */
export const LOCAL_ONLY_DATASETS: readonly AdapterKey[] = ['real-sales'];

/** The Apache-2.0 datasets: what a deployment imports (`--dataset licensed`). */
export const LICENSED_DATASETS: readonly AdapterKey[] = ['gwenshap', 'saas'];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True if the Postgres URL points at this machine (e.g. docker compose on localhost:5434). */
export function isLocalDatabase(databaseUrl: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(databaseUrl).hostname);
  } catch {
    return false; // unparsable: don't assume it's safe
  }
}

/** Why this import must not run, or null if it may. */
export function localOnlyViolation(
  datasets: readonly string[],
  databaseUrl: string,
): string | null {
  if (isLocalDatabase(databaseUrl)) return null;
  const blocked = datasets.filter((d) => (LOCAL_ONLY_DATASETS as readonly string[]).includes(d));
  if (blocked.length === 0) return null;
  let host = 'an unparsable URL';
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    // keep the placeholder
  }
  return (
    `Refusing to import ${blocked.join(', ')} into a database that isn't on this machine (${host}). ` +
    'It has no stated license, so it stays local-only: a deployed app is open to anyone with a GitHub account. ' +
    `For a deployment, import the Apache-2.0 datasets only: pnpm ingest -- --dataset licensed (${LICENSED_DATASETS.join(' + ')}).`
  );
}
