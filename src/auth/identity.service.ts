import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Database } from '../db/db.module';
import { assertAdmitted } from './admission';
import { UNSCOPED_DB_SIGN_IN_ONLY } from './unscoped-db.token';

export interface ProviderIdentity {
  provider: 'google' | 'microsoft';
  /** The provider's immutable subject id — Google `sub`, Microsoft `oid:tid`. */
  externalId: string;
  email?: string;
  name?: string;
}

/**
 * Turns a verified provider identity into a local user (T12/T42).
 *
 * The lookup runs through the `auth_find_or_create_user` SECURITY DEFINER
 * function (migration 0008), not through ordinary queries: sign-in has to read
 * an identity *before* it knows who the caller is, so there is no
 * `app.current_user_id` for RLS to scope by. Routing it through one narrow
 * function keeps the app's own connection free of RLS-bypassing privileges.
 *
 * Admission (`assertAdmitted`) runs before anything is created: a verified
 * Google identity proves who someone is, not that they may use this system.
 *
 * The security-critical rule, enforced in the function and mirrored here: an
 * account is found **only** by (provider, external_id). An unrecognized
 * subject creates a NEW account even when its email matches an existing user —
 * auto-linking on email is an account-takeover path. Attaching a second
 * provider to an existing account is a separate authenticated action, never an
 * inference made during sign-in.
 */
@Injectable()
export class IdentityService {
  constructor(@Inject(UNSCOPED_DB_SIGN_IN_ONLY) private readonly db: Database) {}

  async findOrCreateUser(identity: ProviderIdentity): Promise<string> {
    // Admission is checked here rather than in the controller so every present
    // and future provider flow passes through it — a second provider's
    // callback cannot forget a check it doesn't have to remember.
    assertAdmitted(identity.provider, identity.externalId);

    const result = await this.db.execute<{ auth_find_or_create_user: string }>(
      sql`SELECT auth_find_or_create_user(
        ${identity.provider}::auth_provider,
        ${identity.externalId},
        ${identity.email ?? null},
        ${identity.name ?? null}
      )`,
    );

    const userId = result.rows[0]?.auth_find_or_create_user;
    if (!userId) {
      throw new Error('auth_find_or_create_user returned no user id.');
    }
    return userId;
  }
}
