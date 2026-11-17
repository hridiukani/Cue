/** Postgres SQLSTATE codes we handle explicitly. */
export const PG_ERROR = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  invalidTextRepresentation: '22P02',
} as const;

export interface PgErrorInfo {
  code: string;
  constraint: string | undefined;
}

/**
 * Find the Postgres error inside `err`, if any. Drizzle wraps driver errors,
 * so walk the `.cause` chain looking for a 5-character SQLSTATE code.
 */
export function getPgError(err: unknown): PgErrorInfo | null {
  let e: unknown = err;
  while (e instanceof Error) {
    if ('code' in e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
      const constraint =
        'constraint_name' in e && typeof e.constraint_name === 'string'
          ? e.constraint_name
          : undefined;
      return { code: e.code, constraint };
    }
    e = e.cause;
  }
  return null;
}
