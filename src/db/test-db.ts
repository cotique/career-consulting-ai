// Test-only helpers — connect straight to env vars (via vitest.setup.ts's
// dotenv load), bypassing SecretsService/Nest DI. These are integration
// tests against the real local Postgres (docker-compose, T2), not units.
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set — is the local Postgres running (docker compose up -d) and .env present?`,
    );
  }
  return value;
}

/** app_user (non-superuser) — the role RLS actually applies to, same as the real app. */
export function createTestDb() {
  const pool = new Pool({ connectionString: requireEnv('DATABASE_URL') });
  return { db: drizzle(pool, { schema }), pool };
}

/**
 * jobsearch (superuser) — for test fixture setup/teardown only. RLS's
 * WITH CHECK blocks app_user from inserting rows for a user_id that isn't
 * the current session's `app.current_user_id` (correct, real behavior —
 * see 0002_app_runtime_role.sql) — but seeding fixtures for *multiple*
 * users at once doesn't correspond to any real single-request context, so
 * fixture setup goes through the admin role instead of fighting RLS for it.
 */
export function createAdminDb() {
  const pool = new Pool({ connectionString: requireEnv('MIGRATION_DATABASE_URL') });
  return { db: drizzle(pool, { schema }), pool };
}

/**
 * Re-exported from the runtime module (T12 promoted it out of this test
 * helper): tests exercise exactly the same code path a real authenticated
 * request takes, rather than a look-alike that could drift from it.
 */
export { withUserContext } from './user-context';
