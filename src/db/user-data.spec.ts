import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminDb, createTestDb, withUserContext } from './test-db';
import { deleteUserData, exportUserData } from './user-data';
import * as schema from './schema';
import type { Database } from './db.module';

// Fixture setup/teardown uses the admin (superuser) connection — seeding
// multiple users' data doesn't correspond to any real single-request
// context, so it isn't worth fighting RLS for (see test-db.ts). The actual
// deleteUserData/exportUserData calls under test go through app_user via
// withUserContext, exactly as a real (post-T12) request would.
const { db: adminDb, pool: adminPool } = createAdminDb();
const { pool: appPool } = createTestDb();

/** Inserts one row into every user-owned table for `userId`, returning the ids created. */
async function seedFullUser(db: Database, userId: string) {
  await db.insert(schema.users).values({ id: userId, name: 'Test User' });
  await db.insert(schema.authIdentities).values({
    userId,
    provider: 'google',
    externalId: `ext-${userId}`,
  });
  await db.insert(schema.userProfiles).values({ userId });

  const [resume] = await db
    .insert(schema.resumes)
    .values({ userId, blobStoragePath: 'blob://resume.pdf', mimeType: 'application/pdf' })
    .returning();
  await db.insert(schema.resumeExtractions).values({
    userId,
    resumeId: resume.id,
    structuredJson: { skills: ['ts'] },
    modelUsed: 'test-model',
  });

  const [vacancy] = await db
    .insert(schema.vacancies)
    .values({ userId, sourceType: 'paste', rawText: 'a vacancy' })
    .returning();
  await db.insert(schema.vacancyScores).values({
    userId,
    vacancyId: vacancy.id,
    score: '0.8',
    modelUsed: 'test-model',
    promptVersion: 'v1',
  });
  await db.insert(schema.tailoredDocuments).values({
    userId,
    vacancyId: vacancy.id,
    resumeId: resume.id,
    docType: 'resume',
    content: 'tailored content',
    modelUsed: 'test-model',
    promptVersion: 'v1',
  });

  const [application] = await db
    .insert(schema.applications)
    .values({ userId, vacancyId: vacancy.id })
    .returning();
  await db.insert(schema.applicationEvents).values({
    userId,
    applicationId: application.id,
    eventType: 'sourced',
  });

  await db.insert(schema.llmUsageLogs).values({
    userId,
    taskType: 'scoring',
    promptVersion: 'v1',
    provider: 'test-provider',
    model: 'test-model',
    inputTokens: 10,
    outputTokens: 20,
    costEstimate: '0.001',
  });

  return { resumeId: resume.id, vacancyId: vacancy.id, applicationId: application.id };
}

describe('deleteUserData (cascade)', () => {
  const userId = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it('removes the user and every dependent row across all tables', async () => {
    const { resumeId, vacancyId, applicationId } = await seedFullUser(adminDb, userId);

    // The real call under test runs as app_user, with the session scoped to
    // the same user being deleted — exactly how a real "delete my account"
    // request behaves once T12 wires per-request auth context.
    await withUserContext(appPool, userId, (scopedDb) => deleteUserData(scopedDb, userId));

    expect(await adminDb.select().from(schema.users).where(eq(schema.users.id, userId))).toHaveLength(0);
    expect(
      await adminDb.select().from(schema.authIdentities).where(eq(schema.authIdentities.userId, userId)),
    ).toHaveLength(0);
    expect(
      await adminDb.select().from(schema.userProfiles).where(eq(schema.userProfiles.userId, userId)),
    ).toHaveLength(0);
    expect(await adminDb.select().from(schema.resumes).where(eq(schema.resumes.id, resumeId))).toHaveLength(0);
    expect(
      await adminDb
        .select()
        .from(schema.resumeExtractions)
        .where(eq(schema.resumeExtractions.resumeId, resumeId)),
    ).toHaveLength(0);
    expect(
      await adminDb.select().from(schema.vacancies).where(eq(schema.vacancies.id, vacancyId)),
    ).toHaveLength(0);
    expect(
      await adminDb.select().from(schema.vacancyScores).where(eq(schema.vacancyScores.vacancyId, vacancyId)),
    ).toHaveLength(0);
    expect(
      await adminDb
        .select()
        .from(schema.tailoredDocuments)
        .where(eq(schema.tailoredDocuments.vacancyId, vacancyId)),
    ).toHaveLength(0);
    expect(
      await adminDb.select().from(schema.applications).where(eq(schema.applications.id, applicationId)),
    ).toHaveLength(0);
    expect(
      await adminDb
        .select()
        .from(schema.applicationEvents)
        .where(eq(schema.applicationEvents.applicationId, applicationId)),
    ).toHaveLength(0);
    expect(
      await adminDb.select().from(schema.llmUsageLogs).where(eq(schema.llmUsageLogs.userId, userId)),
    ).toHaveLength(0);
  });
});

describe('exportUserData', () => {
  const userId = '22222222-2222-2222-2222-222222222222';
  const otherUserId = '33333333-3333-3333-3333-333333333333';

  beforeEach(async () => {
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
    await adminDb.delete(schema.users).where(eq(schema.users.id, otherUserId));
  });

  it('returns exactly one user\'s data, not another user\'s', async () => {
    await seedFullUser(adminDb, userId);
    await seedFullUser(adminDb, otherUserId);

    const exported = await withUserContext(appPool, userId, (scopedDb) =>
      exportUserData(scopedDb, userId),
    );

    expect(exported.user.id).toBe(userId);
    expect(exported.resumes).toHaveLength(1);
    expect(exported.vacancies).toHaveLength(1);
    expect(exported.applications).toHaveLength(1);
    expect(exported.resumeExtractions).toHaveLength(1);
    expect(exported.vacancyScores).toHaveLength(1);
    expect(exported.tailoredDocuments).toHaveLength(1);
    expect(exported.applicationEvents).toHaveLength(1);
    expect(exported.llmUsageLogs).toHaveLength(1);
    expect(exported.resumes.every((r) => r.userId === userId)).toBe(true);
    expect(exported.vacancies.every((v) => v.userId === userId)).toBe(true);
  });

  it('throws for a user that does not exist', async () => {
    await seedFullUser(adminDb, userId); // gives app_user's session something owned, irrelevant to the lookup below
    await expect(
      withUserContext(appPool, userId, (scopedDb) =>
        exportUserData(scopedDb, '00000000-0000-0000-0000-000000000000'),
      ),
    ).rejects.toThrow(/not found/);
  });
});

afterAll(async () => {
  await adminPool.end();
  await appPool.end();
});
