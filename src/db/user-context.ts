import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient } from 'pg';
import * as schema from './schema';
import type { Database } from './db.module';

/**
 * Runs `callback` inside one transaction with `app.current_user_id` set to
 * `userId`, so Postgres RLS scopes every query the callback makes (NFR5).
 *
 * This is the runtime half of the RLS design: policies were written and
 * tested in Epic 1, but nothing set the session variable on a real request
 * until now. The auth interceptor wraps each authenticated request in this,
 * and handlers receive the scoped `Database` rather than the global one.
 *
 * `set_config(..., true)` rather than `SET LOCAL app.current_user_id = $1`:
 * SET is a utility command whose grammar takes no bind parameters at all,
 * while set_config is an ordinary function that does — same transaction-local
 * effect, without interpolating a value into SQL text.
 */
export async function withUserContext<T>(
  pool: Pool,
  userId: string,
  callback: (scopedDb: Database) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const scopedDb = drizzle(client, { schema });
    const result = await callback(scopedDb);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
