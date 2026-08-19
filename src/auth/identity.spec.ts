import { ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminDb, createTestDb } from '../db/test-db';
import * as schema from '../db/schema';
import { IdentityService } from './identity.service';

// Integration: the identity bootstrap runs through the SECURITY DEFINER
// function (migration 0008) against real Postgres, as app_user — the same
// role and path a real sign-in takes.
const { db: adminDb, pool: adminPool } = createAdminDb();
const { db: appDb, pool: appPool } = createTestDb();

const service = new IdentityService(appDb);

const SUB_A = 'google-sub-aaa';
const SUB_B = 'google-sub-bbb';
const SHARED_EMAIL = 'same-address@example.com';

async function cleanup() {
  for (const sub of [SUB_A, SUB_B]) {
    const [identity] = await adminDb
      .select({ userId: schema.authIdentities.userId })
      .from(schema.authIdentities)
      .where(eq(schema.authIdentities.externalId, sub));
    if (identity) {
      await adminDb.delete(schema.users).where(eq(schema.users.id, identity.userId));
    }
  }
}

describe('IdentityService (T12/T42)', () => {
  beforeEach(async () => {
    await cleanup();
    process.env.AUTH_ALLOWED_SUBJECTS = `google:${SUB_A}, google:${SUB_B}`;
  });
  afterAll(async () => {
    await cleanup();
    delete process.env.AUTH_ALLOWED_SUBJECTS;
    await adminPool.end();
    await appPool.end();
  });

  it('creates a user and identity on first sign-in', async () => {
    const userId = await service.findOrCreateUser({
      provider: 'google',
      externalId: SUB_A,
      email: 'first@example.com',
      name: 'First User',
    });

    const [user] = await adminDb.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user.name).toBe('First User');

    const identities = await adminDb
      .select()
      .from(schema.authIdentities)
      .where(eq(schema.authIdentities.userId, userId));
    expect(identities).toHaveLength(1);
    expect(identities[0].provider).toBe('google');
    expect(identities[0].externalId).toBe(SUB_A);
  });

  it('returns the same user on repeat sign-in, without duplicating rows', async () => {
    const first = await service.findOrCreateUser({ provider: 'google', externalId: SUB_A });
    const second = await service.findOrCreateUser({ provider: 'google', externalId: SUB_A });
    const third = await service.findOrCreateUser({
      provider: 'google',
      externalId: SUB_A,
      // A changed display name must not fork the account — identity is the
      // subject claim, not the profile attached to it.
      name: 'Renamed',
    });

    expect(second).toBe(first);
    expect(third).toBe(first);

    const identities = await adminDb
      .select()
      .from(schema.authIdentities)
      .where(eq(schema.authIdentities.externalId, SUB_A));
    expect(identities).toHaveLength(1);
  });

  // A verified Google identity says who someone is, not that they may use this
  // system. Without admission control anyone who reaches the URL becomes a
  // user, and each user can spend up to their own monthly LLM cap — so total
  // spend would be set by however many strangers signed up.
  describe('admission control', () => {
    it('refuses a subject that is not on the allow-list, creating nothing', async () => {
      process.env.AUTH_ALLOWED_SUBJECTS = 'google:somebody-else';

      await expect(
        service.findOrCreateUser({ provider: 'google', externalId: SUB_A }),
      ).rejects.toThrow(ForbiddenException);

      const identities = await adminDb
        .select()
        .from(schema.authIdentities)
        .where(eq(schema.authIdentities.externalId, SUB_A));
      expect(identities).toHaveLength(0);
    });

    // Fail closed: a deploy that forgets the variable must admit nobody. If an
    // unset list meant "allow everyone", forgetting it would silently produce
    // the open system this check exists to prevent.
    it('admits nobody when the allow-list is unset or empty', async () => {
      delete process.env.AUTH_ALLOWED_SUBJECTS;
      await expect(
        service.findOrCreateUser({ provider: 'google', externalId: SUB_A }),
      ).rejects.toThrow(ForbiddenException);

      process.env.AUTH_ALLOWED_SUBJECTS = '   ,  ';
      await expect(
        service.findOrCreateUser({ provider: 'google', externalId: SUB_A }),
      ).rejects.toThrow(ForbiddenException);
    });

    // The allow-list is keyed by provider too, so the same subject string from
    // a different provider is a different principal.
    it('does not admit the same subject under another provider', async () => {
      process.env.AUTH_ALLOWED_SUBJECTS = `google:${SUB_A}`;
      await expect(
        service.findOrCreateUser({ provider: 'microsoft', externalId: SUB_A }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // The reason T42 exists. If a new provider subject were matched to an
  // existing account by email, anyone who obtains an address that once
  // belonged to a user — or any provider that doesn't verify the email claim —
  // could take over that account. A separate account is the safe outcome.
  it('does NOT link a new subject to an existing account sharing the same email', async () => {
    const original = await service.findOrCreateUser({
      provider: 'google',
      externalId: SUB_A,
      email: SHARED_EMAIL,
    });

    const impostor = await service.findOrCreateUser({
      provider: 'google',
      externalId: SUB_B,
      email: SHARED_EMAIL,
    });

    expect(impostor).not.toBe(original);

    const identities = await adminDb
      .select()
      .from(schema.authIdentities)
      .where(eq(schema.authIdentities.email, SHARED_EMAIL));
    expect(identities).toHaveLength(2);
    expect(new Set(identities.map((i) => i.userId)).size).toBe(2);
  });
});
