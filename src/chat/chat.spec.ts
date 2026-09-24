import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../app.module';
import { SESSION_COOKIE, SessionService } from '../auth/session.service';
import { createAdminDb } from '../db/test-db';
import * as schema from '../db/schema';
import { AnthropicProvider } from '../llm/providers/anthropic.provider';
import { FakeEmbeddingProvider } from '../llm/providers/fake-embedding.provider';
import { OpenAiEmbeddingProvider } from '../llm/providers/openai-embedding.provider';
import { FakeProvider } from '../llm/providers/fake.provider';
import type {
  LlmProvider,
  ProviderCompletionParams,
  ProviderCompletionResult,
} from '../llm/providers/provider.interface';

/**
 * Chat (T19) end to end: real HTTP through the whole stack, real Postgres,
 * real retrieval (RetrievalService.search runs for real against real chunk
 * tables). Both providers are fakes — no test here spends real money.
 */
const { db: adminDb, pool: adminPool } = createAdminDb();

const USER_A = 'c19c19c1-0000-4000-8000-0000000019c1';
const USER_B = 'd19d19d1-0000-4000-8000-0000000019d1';

let app: INestApplication;
let sessions: SessionService;
let fakeEmbedding: FakeEmbeddingProvider;

let fakeCompletion = new FakeProvider();
const delegatingCompletionProvider: LlmProvider = {
  complete: (params: ProviderCompletionParams): Promise<ProviderCompletionResult> =>
    fakeCompletion.complete(params),
};

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

function send(cookie: string, message: string, conversationId?: string) {
  return request(app.getHttpServer())
    .post('/me/chat')
    .set('Cookie', cookie)
    .send({ message, ...(conversationId ? { conversationId } : {}) });
}

function getConversation(cookie: string, conversationId: string) {
  return request(app.getHttpServer()).get(`/me/chat/${conversationId}`).set('Cookie', cookie);
}

async function messagesFor(conversationId: string) {
  return adminDb.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
}

/** A real chunk with a non-null embedding, so RetrievalService.search() has something to return. */
async function seedGroundedResumeChunk(userId: string) {
  const [resume] = await adminDb
    .insert(schema.resumes)
    .values({ userId, blobStoragePath: `${userId}/resume.pdf`, mimeType: 'application/pdf' })
    .returning();
  const [extraction] = await adminDb
    .insert(schema.resumeExtractions)
    .values({ userId, resumeId: resume.id, structuredJson: { name: 'Jane Doe' }, modelUsed: 'test-model' })
    .returning();
  await adminDb.insert(schema.resumeExtractionChunks).values({
    userId,
    resumeExtractionId: extraction.id,
    content: 'Jane Doe, Backend Engineer with 5 years experience.',
    contentHash: 'test-hash',
    embedding: Array.from({ length: 1536 }, () => 0.1),
    embeddingModel: 'text-embedding-3-small',
  });
}

beforeAll(async () => {
  fakeEmbedding = new FakeEmbeddingProvider();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AnthropicProvider)
    .useValue(delegatingCompletionProvider)
    .overrideProvider(OpenAiEmbeddingProvider)
    .useValue(fakeEmbedding)
    .compile();

  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  sessions = app.get(SessionService);
});

afterAll(async () => {
  for (const userId of [USER_A, USER_B]) {
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
  }
  await app?.close();
  await adminPool.end();
});

beforeEach(async () => {
  fakeCompletion = new FakeProvider({ text: 'Here is what I found.', inputTokens: 100, outputTokens: 50 });
  for (const userId of [USER_A, USER_B]) {
    await adminDb.delete(schema.users).where(eq(schema.users.id, userId));
  }
  await adminDb.insert(schema.users).values([
    { id: USER_A, name: 'User A' },
    { id: USER_B, name: 'User B' },
  ]);
});

describe('sending a message (FR24)', () => {
  it('starts a new conversation when none is given', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const res = await send(cookie, 'What backend roles have I saved?').expect(201);

    expect(res.body.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.reply).toBe('Here is what I found.');
    expect(res.body.sources).toEqual([]);

    const rows = await messagesFor(res.body.conversationId);
    expect(rows.map((r) => r.role).sort()).toEqual(['assistant', 'user']);
  });

  it('continues an existing conversation, with the prior turn reaching the prompt exactly once', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const first = await send(cookie, 'My name is Jane.').expect(201);

    await send(cookie, 'What did I just tell you?', first.body.conversationId).expect(201);

    const [, secondCall] = fakeCompletion.calls;
    // Exactly once, not 'contains' — history is fetched before the new
    // message is inserted specifically so this can never double up: once
    // in the history block, again in the separate user_message block.
    const occurrences = secondCall.userMessage.split('My name is Jane.').length - 1;
    expect(occurrences).toBe(1);
    expect(secondCall.userMessage).toContain('What did I just tell you?');
  });

  it('persists which chunks an answer was grounded in, readable via GET', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await seedGroundedResumeChunk(USER_A);

    const { body } = await send(cookie, 'Tell me about my resume.').expect(201);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toMatchObject({ sourceTable: 'resume_extraction' });

    const history = await getConversation(cookie, body.conversationId).expect(200);
    expect(history.body.messages).toHaveLength(2);
    const assistantMessage = history.body.messages.find((m: { role: string }) => m.role === 'assistant');
    expect(assistantMessage.content).toBe('Here is what I found.');
    // The read path returns the same grounding the write path persisted —
    // not just that a row exists, which would pass even with retrievedContext
    // dropped on the way back out.
    expect(assistantMessage.sources).toEqual(body.sources);
  });

  it('refuses an empty message with 400, spending nothing', async () => {
    const cookie = await sessionCookieFor(USER_A);
    fakeEmbedding.calls = [];
    fakeCompletion.calls = [];
    await send(cookie, '   ').expect(400);
    expect(fakeEmbedding.calls).toHaveLength(0);
    expect(fakeCompletion.calls).toHaveLength(0);
  });

  it('refuses a malformed conversationId with 400', async () => {
    const cookie = await sessionCookieFor(USER_A);
    await send(cookie, 'hello', 'not-a-uuid').expect(400);
  });

  it("refuses someone else's conversationId with 404, not 403", async () => {
    const cookieA = await sessionCookieFor(USER_A);
    const cookieB = await sessionCookieFor(USER_B);
    const { body } = await send(cookieA, 'hello').expect(201);

    await send(cookieB, 'hello', body.conversationId).expect(404);
  });

  it('refuses an unauthenticated send', async () => {
    await request(app.getHttpServer()).post('/me/chat').send({ message: 'hi' }).expect(401);
  });

  it('refuses the 51st turn of one conversation with 429', async () => {
    const cookie = await sessionCookieFor(USER_A);
    const { body } = await send(cookie, 'turn one').expect(201);

    // Fast-forwards straight to the boundary rather than driving 50 real
    // HTTP round trips — this still exercises the real enforcement query
    // (conversationUsage counts attempt=1 rows for this conversationId),
    // just seeds the state it reads instead of re-deriving it the slow way.
    const usageRows = Array.from({ length: 49 }, () => ({
      userId: USER_A,
      taskType: 'chat',
      promptVersion: 'chat-v1',
      conversationId: body.conversationId,
      attempt: 1,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      inputTokens: 10,
      outputTokens: 10,
      costEstimate: '0.0001',
    }));
    await adminDb.insert(schema.llmUsageLogs).values(usageRows);

    const res = await send(cookie, 'turn fifty-one', body.conversationId).expect(429);
    expect(res.body.message).toContain('50-turn limit');
  });
});
