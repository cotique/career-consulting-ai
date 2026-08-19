import { eq } from 'drizzle-orm';
import type { Database } from './db.module';
import * as schema from './schema';

/**
 * Deletes a user and everything derived from them in one action (FR5, NFR6).
 * Relies entirely on the schema's ON DELETE CASCADE chains — no per-table
 * cleanup here. If a future table forgets `onDelete: 'cascade'`, this will
 * leave orphaned rows; that's a schema bug to catch in tests, not something
 * to work around here with manual deletes.
 */
export async function deleteUserData(db: Database, userId: string): Promise<void> {
  await db.delete(schema.users).where(eq(schema.users.id, userId));
}

/**
 * Returns everything owned by a user as one plain JSON-serializable object
 * (FR5, NFR6). No file/ZIP packaging — there's no delivery mechanism yet
 * (that needs FR1/T12), and inventing one now would be a speculative
 * abstraction the plan explicitly didn't ask for.
 */
export async function exportUserData(db: Database, userId: string) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!user) {
    throw new Error(`User "${userId}" not found.`);
  }

  const authIdentities = await db
    .select()
    .from(schema.authIdentities)
    .where(eq(schema.authIdentities.userId, userId));

  const [userProfile] = await db
    .select()
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId));

  // Every user-owned table carries `user_id` directly (migration 0005), so
  // each of these is a single scoped query — no walking down from parent ids.
  const resumes = await db.select().from(schema.resumes).where(eq(schema.resumes.userId, userId));
  const resumeExtractions = await db
    .select()
    .from(schema.resumeExtractions)
    .where(eq(schema.resumeExtractions.userId, userId));

  const vacancies = await db
    .select()
    .from(schema.vacancies)
    .where(eq(schema.vacancies.userId, userId));
  const vacancyScores = await db
    .select()
    .from(schema.vacancyScores)
    .where(eq(schema.vacancyScores.userId, userId));
  const tailoredDocuments = await db
    .select()
    .from(schema.tailoredDocuments)
    .where(eq(schema.tailoredDocuments.userId, userId));

  const applications = await db
    .select()
    .from(schema.applications)
    .where(eq(schema.applications.userId, userId));
  const applicationEvents = await db
    .select()
    .from(schema.applicationEvents)
    .where(eq(schema.applicationEvents.userId, userId));

  const llmUsageLogs = await db
    .select()
    .from(schema.llmUsageLogs)
    .where(eq(schema.llmUsageLogs.userId, userId));

  return {
    user,
    authIdentities,
    userProfile: userProfile ?? null,
    resumes,
    resumeExtractions,
    vacancies,
    vacancyScores,
    tailoredDocuments,
    applications,
    applicationEvents,
    llmUsageLogs,
  };
}
