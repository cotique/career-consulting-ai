// Manual smoke test — makes ONE real Anthropic call (~fraction of a cent).
// Not part of `npm test` (which never touches real providers). Run with:
//   node --env-file=.env -r tsx/cjs src/llm/smoke.ts
// Requires ANTHROPIC_API_KEY in .env and the local Postgres running.
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { SecretsService } from '../config/secrets.service';
import { createAdminDb, createTestDb } from '../db/test-db';
import * as schema from '../db/schema';
import { AnthropicProvider } from './providers/anthropic.provider';
import { LlmService } from './llm.service';
import { ONBOARDING_FREE_TEXT } from './templates';

const SMOKE_USER_ID = '99999999-9999-9999-9999-999999999999';

async function main() {
  const { db: adminDb, pool: adminPool } = createAdminDb();
  const { pool: appPool } = createTestDb();

  await adminDb
    .insert(schema.users)
    .values({ id: SMOKE_USER_ID, name: 'Smoke Test' })
    .onConflictDoNothing();

  const provider = new AnthropicProvider(new SecretsService());
  const service = LlmService.withProviders({ anthropic: provider }, appPool);

  // Uses a real registry template — there is no free-form instructions path
  // any more, and a smoke test that took one would be testing a road nobody
  // else drives on.
  const response = await service.completeStructured(
    {
      template: 'onboarding_parse',
      userId: SMOKE_USER_ID,
      untrusted: { [ONBOARDING_FREE_TEXT]: 'Remote product manager roles in Warsaw.' },
      params: { language: 'en', market: 'PL' },
      maxTokens: 256,
    },
    z.object({ workMode: z.string().nullish() }).passthrough(),
  );

  console.log('Response:', JSON.stringify(response, null, 2));

  const [logged] = await adminDb
    .select()
    .from(schema.llmUsageLogs)
    .where(eq(schema.llmUsageLogs.userId, SMOKE_USER_ID))
    .orderBy(desc(schema.llmUsageLogs.createdAt))
    .limit(1);
  console.log('Logged usage row:', JSON.stringify(logged, null, 2));

  await adminPool.end();
  await appPool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
