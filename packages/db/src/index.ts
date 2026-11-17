// App-facing entry. Bundled into apps/web, so nothing here may touch the file
// system. Node-only code (migrations, seed, .env loading, test DBs) is imported
// by path from scripts/ and test/, or via the `@cue/db/testing` subpath.
export { createDb, type Db } from './client';
export { loadDbConfig, type DbConfig } from './config';
export * as schema from './schema';
export { toSuggestionTimings, type SuggestionTimestampColumns } from './timings';
export {
  EmailAlreadyLinkedError,
  findOrCreateOAuthUser,
  getSessionUser,
  type OAuthIdentity,
} from './repositories/users';
export { getPgError, PG_ERROR, type PgErrorInfo } from './errors';
export {
  createPlaybook,
  deletePlaybook,
  getPlaybook,
  listPlaybooks,
  updatePlaybook,
  type DeletePlaybookResult,
  type PlaybookListItem,
} from './repositories/playbooks';
export type { Playbook } from './schema';
