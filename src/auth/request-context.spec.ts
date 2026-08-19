import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../app.module';
import { createAdminDb } from '../db/test-db';
import * as schema from '../db/schema';
import { SESSION_COOKIE, SessionService } from './session.service';

/**
 * The gap this epic closes: RLS was proven in Epic 1 through a test helper,
 * but nothing set `app.current_user_id` on a real request. These tests drive
 * the actual HTTP stack — guard, session cookie, per-request scoped
 * connection — so an authenticated request is verified end to end rather than
 * a look-alike of one.
 */
const { db: adminDb, pool: adminPool } = createAdminDb();

const USER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER_B = 'bbbbbbbb-0000-4000-8000-000000000002';

let app: INestApplication;
let sessions: SessionService;

/** Mints a session cookie directly — the Google round trip can't run in a test. */
async function sessionCookieFor(userId: string): Promise<string> {
  const captured: string[] = [];
  const fakeRes = {
    cookie(name: string, value: string) {
      captured.push(`${name}=${value}`);
      return this;
    },
  };
  await sessions.issue(fakeRes as never, userId);
  return captured.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  sessions = app.get(SessionService);
});

afterAll(async () => {
  await app?.close();
  await adminPool.end();
});

beforeEach(async () => {
  for (const id of [USER_A, USER_B]) {
    await adminDb.delete(schema.users).where(eq(schema.users.id, id));
  }
  await adminDb.insert(schema.users).values([
    { id: USER_A, name: 'User A' },
    { id: USER_B, name: 'User B' },
  ]);
  // One vacancy per user — the row each must not see from the other's session.
  await adminDb.insert(schema.vacancies).values([
    { userId: USER_A, sourceType: 'paste', rawText: 'A private vacancy', countryCode: 'PL' },
    { userId: USER_B, sourceType: 'paste', rawText: 'B private vacancy', countryCode: 'DE' },
  ]);
});

describe('authenticated request path (T12, NFR5)', () => {
  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/me').expect(401);
  });

  it('rejects a tampered session cookie', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const tampered = `${cookie.slice(0, -3)}xyz`;
    await request(app.getHttpServer()).get('/me').set('Cookie', tampered).expect(401);
  });

  it('returns the signed-in user', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const res = await request(app.getHttpServer()).get('/me').set('Cookie', cookie).expect(200);
    expect(res.body.user.id).toBe(USER_A);
    expect(res.body.user.name).toBe('User A');
  });

  it('scopes data to the session user — A never sees B rows through the handler', async () => {
    const cookieA = await sessionCookieFor(USER_A);
    const res = await request(app.getHttpServer())
      .get('/me/export')
      .set('Cookie', cookieA)
      .expect(200);

    expect(res.body.vacancies).toHaveLength(1);
    expect(res.body.vacancies[0].rawText).toBe('A private vacancy');
    expect(JSON.stringify(res.body)).not.toContain('B private vacancy');
  });
});

describe('OAuth callback guards (T42)', () => {
  // A callback arriving without the state/verifier cookies didn't come from a
  // flow this server started — the shape of a CSRF attempt. Verifying `state`
  // itself is delegated to openid-client (certified, checks it during the code
  // exchange); this asserts our own precondition, which runs before that.
  it('rejects a callback with no pending sign-in', async () => {
    await request(app.getHttpServer())
      .get('/auth/google/callback?code=whatever&state=whatever')
      .expect(401);
  });
});

describe('account deletion (FR5)', () => {
  it('refuses without the explicit confirmation token', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await request(app.getHttpServer()).delete('/me').set('Cookie', cookie).expect(400);

    const [stillThere] = await adminDb
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, USER_A));
    expect(stillThere).toBeDefined();
  });

  // Found while exercising the API by hand: a stateless token stays
  // cryptographically valid after the account it names is deleted, so without
  // an existence check the guard kept treating it as authenticated for the
  // rest of its 30-day life and handlers operated on a missing user.
  it('stops accepting the session once the account is gone', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await request(app.getHttpServer())
      .delete('/me?confirm=DELETE')
      .set('Cookie', cookie)
      .expect(200);

    await request(app.getHttpServer()).get('/me').set('Cookie', cookie).expect(401);
  });

  it('deletes the account and cascades, leaving other users untouched', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await request(app.getHttpServer())
      .delete('/me?confirm=DELETE')
      .set('Cookie', cookie)
      .expect(200);

    const remainingUsers = await adminDb
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, USER_A));
    expect(remainingUsers).toHaveLength(0);

    const orphanedVacancies = await adminDb
      .select()
      .from(schema.vacancies)
      .where(eq(schema.vacancies.userId, USER_A));
    expect(orphanedVacancies).toHaveLength(0);

    const [userB] = await adminDb.select().from(schema.users).where(eq(schema.users.id, USER_B));
    expect(userB).toBeDefined();
  });
});

describe('onboarding (T13, T14)', () => {
  it('saves profile fields and rejects a non-European market', async () => {
    const cookie = await sessionCookieFor(USER_A);

    await request(app.getHttpServer())
      .post('/onboarding')
      .set('Cookie', cookie)
      .send({
        name: 'Alex',
        targetRoles: ['Product Manager'],
        uiLanguage: 'en',
        targetMarkets: [{ countryCode: 'PL', city: 'Warsaw', remote: true }],
        timezone: 'Europe/Warsaw',
        preferredNotificationTime: '09:00',
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/onboarding')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.uiLanguage).toBe('en');
    expect(res.body.targetMarkets[0].countryCode).toBe('PL');
    expect(res.body.timezone).toBe('Europe/Warsaw');
    expect(res.body.preferredNotificationTime).toBe('09:00');

    await request(app.getHttpServer())
      .post('/onboarding')
      .set('Cookie', cookie)
      .send({ targetMarkets: [{ countryCode: 'US' }] })
      .expect(400);

    // uiLanguage reaches the trusted half of a prompt as the LLM layer's
    // `language` parameter, so a free-text value is refused on the way in
    // rather than blowing up later at request time.
    await request(app.getHttpServer())
      .post('/onboarding')
      .set('Cookie', cookie)
      .send({ uiLanguage: 'English' })
      .expect(400);
  });

  it('preserves fields omitted from a partial step submission', async () => {
    const cookie = await sessionCookieFor(USER_A);

    await request(app.getHttpServer())
      .post('/onboarding')
      .set('Cookie', cookie)
      .send({ uiLanguage: 'pl', timezone: 'Europe/Warsaw' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/onboarding')
      .set('Cookie', cookie)
      .send({ targetRoles: ['Analyst'] })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/onboarding')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.targetRoles).toEqual(['Analyst']);
    expect(res.body.uiLanguage).toBe('pl');
    expect(res.body.timezone).toBe('Europe/Warsaw');
  });
});
