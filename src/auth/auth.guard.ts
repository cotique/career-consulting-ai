import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { withUserContext } from '../db/user-context';
import * as schema from '../db/schema';
import { SESSION_COOKIE, SessionService } from './session.service';

/**
 * Establishes *who* the caller is: verifies the session cookie and rejects
 * anonymous requests before any handler runs.
 *
 * That is deliberately only half of the protection (NFR5). The other half is
 * `withUserContext`, which handlers use to open a connection carrying
 * `app.current_user_id` — so Postgres RLS independently refuses rows belonging
 * to anyone else, even if a handler forgets its `WHERE user_id = …`. The guard
 * proves identity; RLS constrains reach.
 *
 * The scoped connection is opened per handler rather than held here: a guard
 * can't keep a transaction open across a handler's lifetime without leaking
 * connections whenever the handler throws.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    const userId = await this.sessions.verify(token);

    if (!userId) {
      throw new UnauthorizedException('Sign in at /auth/google.');
    }

    // Sessions are stateless, so a token stays cryptographically valid until it
    // expires — including after the account it names has been deleted. Without
    // this check such a token keeps passing as authenticated for the rest of
    // its 30-day life, and handlers quietly operate on a user that no longer
    // exists.
    //
    // Cost, stated honestly: not just an indexed lookup — `withUserContext`
    // opens a pooled connection and a transaction (BEGIN, set_config, SELECT,
    // COMMIT) on every authenticated request. Free at one user; if it ever
    // matters, the fix is to fold the check into the handler's own scoped
    // transaction rather than to drop it.
    if (!(await this.userExists(userId))) {
      throw new UnauthorizedException('This account no longer exists.');
    }

    req.userId = userId;
    return true;
  }

  private async userExists(userId: string): Promise<boolean> {
    return withUserContext(this.pool, userId, async (db) => {
      const [user] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      return Boolean(user);
    });
  }
}
