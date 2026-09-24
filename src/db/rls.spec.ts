import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminDb, createTestDb } from './test-db';
import * as schema from './schema';

// Proves Postgres itself enforces row ownership (NFR5's RLS half) — no
// app-level `WHERE user_id = ...` filtering in these queries. Fixtures are
// seeded via the admin (superuser) connection since seeding two users at
// once isn't a real single-request scenario; the actual reads under test
// go through `appPool` (app_user, the same non-superuser role the real app
// uses) to prove RLS applies to the connection that matters.
const { db: adminDb, pool: adminPool } = createAdminDb();
const { pool: appPool } = createTestDb();

const userA = '44444444-4444-4444-4444-444444444444';
const userB = '55555555-5555-5555-5555-555555555555';

describe('Row-Level Security', () => {
  beforeEach(async () => {
    await adminDb.delete(schema.users).where(eq(schema.users.id, userA));
    await adminDb.delete(schema.users).where(eq(schema.users.id, userB));

    await adminDb.insert(schema.users).values([{ id: userA }, { id: userB }]);
    const [resumeA] = await adminDb
      .insert(schema.resumes)
      .values({ userId: userA, blobStoragePath: 'blob://a.pdf', mimeType: 'application/pdf' })
      .returning();
    await adminDb
      .insert(schema.resumes)
      .values({ userId: userB, blobStoragePath: 'blob://b.pdf', mimeType: 'application/pdf' });
    const [resumeExtractionA] = await adminDb
      .insert(schema.resumeExtractions)
      .values({
        userId: userA,
        resumeId: resumeA.id,
        structuredJson: {},
        modelUsed: 'test-model',
      })
      .returning();

    // One row per remaining child table, all owned by userA — the direct-policy
    // tests below assert userB sees none of them.
    const [vacancyA] = await adminDb
      .insert(schema.vacancies)
      .values({ userId: userA, sourceType: 'paste', rawText: 'a vacancy', countryCode: 'PL' })
      .returning();
    await adminDb.insert(schema.resumeExtractionChunks).values({
      userId: userA,
      resumeExtractionId: resumeExtractionA.id,
      content: 'chunk text',
      contentHash: 'hash',
      embeddingModel: 'test-model',
    });
    await adminDb.insert(schema.vacancyChunks).values({
      userId: userA,
      vacancyId: vacancyA.id,
      content: 'chunk text',
      contentHash: 'hash',
      embeddingModel: 'test-model',
    });
    await adminDb.insert(schema.vacancyScores).values({
      userId: userA,
      vacancyId: vacancyA.id,
      score: '0.9',
      modelUsed: 'test-model',
      promptVersion: 'v1',
    });
    await adminDb.insert(schema.tailoredDocuments).values({
      userId: userA,
      vacancyId: vacancyA.id,
      resumeId: resumeA.id,
      docType: 'resume',
      content: 'tailored',
      modelUsed: 'test-model',
      promptVersion: 'v1',
    });
    const [applicationA] = await adminDb
      .insert(schema.applications)
      .values({ userId: userA, vacancyId: vacancyA.id })
      .returning();
    await adminDb.insert(schema.applicationEvents).values({
      userId: userA,
      applicationId: applicationA.id,
      eventType: 'sourced',
    });
  });

  // Using `set_config(...)` rather than `SET LOCAL app.current_user_id = $1`
  // because SET's grammar doesn't accept bind parameters at all (it's a
  // utility command, not a normal statement); `set_config` is a plain SQL
  // function and takes one, with the same transaction-local effect (third
  // arg `true` = is_local).
  it('a direct user_id policy hides other users\' rows without app-level filtering', async () => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userA]);
      const visible = await client.query('SELECT user_id FROM resumes');
      expect(visible.rows).toHaveLength(1);
      expect(visible.rows[0].user_id).toBe(userA);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  // Migration 0006 rewrote these four from join-based policies (reaching the
  // owner through a parent table) to direct `user_id` comparisons — the child
  // tables now carry the owner themselves. Each is asserted independently:
  // a single shared assertion would pass even if three of the four policies
  // were silently dropped.
  it.each([
    'resume_extractions',
    'vacancy_scores',
    'tailored_documents',
    'application_events',
    'applications',
    'resume_extraction_chunks',
    'vacancy_chunks',
  ])('%s: direct user_id policy hides another user\'s rows', async (table) => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');

      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userA]);
      const ownerView = await client.query(`SELECT user_id FROM ${table}`);
      expect(ownerView.rows).toHaveLength(1);
      expect(ownerView.rows[0].user_id).toBe(userA);

      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userB]);
      const otherView = await client.query(`SELECT user_id FROM ${table}`);
      expect(otherView.rows).toHaveLength(0);

      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('with no session variable set, rows are hidden (safe default-deny)', async () => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      const visible = await client.query('SELECT * FROM resumes');
      expect(visible.rows).toHaveLength(0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
});

afterAll(async () => {
  await adminPool.end();
  await appPool.end();
});
