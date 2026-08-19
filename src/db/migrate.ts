// Migration runner — a build/ops-time script, not runtime app code, so it
// reads env vars directly (same pattern as drizzle.config.ts) instead of
// going through SecretsService (that's for the running app, see T5).
//
// Uses MIGRATION_DATABASE_URL (the superuser/admin role), not DATABASE_URL
// (the app's own non-superuser runtime role, see 0002_app_runtime_role.sql)
// — migrations need CREATE TABLE/ROLE/POLICY privileges the app role
// deliberately doesn't have.
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

async function main() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) {
    throw new Error('MIGRATION_DATABASE_URL is not set.');
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool);

  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations applied.');

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
