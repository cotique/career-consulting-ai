import { Global, Module } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { SecretsService } from '../config/secrets.service';
import * as schema from './schema';

export const PG_POOL = 'PG_POOL';
export type Database = NodePgDatabase<typeof schema>;

/**
 * Global — every domain module needs DB access, not worth re-importing.
 *
 * Only the *pool* is exported, deliberately. Code that touches user data takes
 * a scoped `Database` from `withUserContext(pool, …)`, which sets
 * `app.current_user_id` so RLS applies. A ready-made unscoped Drizzle instance
 * used to be exported here too, and that was a loaded gun: injecting it is
 * indistinguishable from injecting the right thing, the code looks correct, the
 * tests pass, and RLS is silently bypassed. The one operation that genuinely
 * has no user context (sign-in — see `UNSCOPED_DB_SIGN_IN_ONLY` in
 * `src/auth/unscoped-db.token.ts`) builds its own, where the name states why.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [SecretsService],
      useFactory: async (secrets: SecretsService): Promise<Pool> => {
        const connectionString = await secrets.getSecret('DATABASE_URL');
        return new Pool({ connectionString });
      },
    },
  ],
  exports: [PG_POOL],
})
export class DbModule {}

/** Builds an unscoped Drizzle instance. RLS does not apply — see the note above. */
export function unscopedDb(pool: Pool): Database {
  return drizzle(pool, { schema });
}
