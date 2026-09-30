import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { asc, desc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { withUserContext } from '../db/user-context';
import * as schema from '../db/schema';
import { httpErrorFor } from '../llm/llm-http';
import { LlmService } from '../llm/llm.service';
import { CHAT_HISTORY, CHAT_MESSAGE, CHAT_RETRIEVED_CONTEXT } from '../llm/templates';
import { RetrievalService, type SearchHit } from '../retrieval/retrieval.service';
import type { SendMessageDto } from './chat.dto';

// No config surface for two numbers — solo-dogfood defaults, not tunables.
const RETRIEVAL_LIMIT = 8;
const HISTORY_MESSAGES = 10; // 5 turns, each a user+assistant pair
const MAX_CONVERSATION_TURNS = 50;

const UNANSWERABLE_MESSAGE =
  'Could not produce an answer — the model did not return a usable response.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ConversationRow = typeof schema.conversations.$inferSelect;
type MessageRow = typeof schema.messages.$inferSelect;

interface StoredSource {
  sourceTable: SearchHit['sourceTable'];
  sourceId: string;
  score: number;
}

/**
 * The single entry point for chat (T19) — the first real caller of the
 * conversation accounting `LlmService` has carried since T9-T11.
 */
@Injectable()
export class ChatService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly retrieval: RetrievalService,
    private readonly llm: LlmService,
  ) {}

  /**
   * Sends a message and returns the answer. Continues `dto.conversationId`
   * if given, starts a new conversation otherwise. History and retrieval are
   * both read before the user's new message is persisted, so neither
   * accidentally includes it twice — once as history, once as the message
   * itself.
   */
  async send(userId: string, dto: SendMessageDto) {
    const message = dto.message?.trim();
    if (!message) {
      throw new BadRequestException('message is empty.');
    }
    // The one entity id in this app that arrives via body rather than a path
    // param under ParseUUIDPipe — same gap T21's vacancyId had, same fix.
    if (dto.conversationId !== undefined && !UUID_RE.test(dto.conversationId)) {
      throw new BadRequestException('conversationId must be a UUID.');
    }

    const conversation = dto.conversationId
      ? await this.loadConversation(userId, dto.conversationId)
      : await this.createConversation(userId);

    const history = await this.recentHistory(userId, conversation.id);
    const hits = await this.retrieval.search(userId, message, RETRIEVAL_LIMIT);

    // Committed before the model is ever called — a turn-cap or budget
    // refusal still leaves the question on record, same as T21's events.
    await this.insertMessage(userId, conversation.id, 'user', message, null);

    let result;
    try {
      result = await this.llm.complete({
        template: 'chat',
        userId,
        untrusted: {
          [CHAT_RETRIEVED_CONTEXT]: renderRetrieved(hits),
          [CHAT_HISTORY]: renderHistory(history),
          [CHAT_MESSAGE]: message,
        },
        conversationId: conversation.id,
        maxTurns: MAX_CONVERSATION_TURNS,
      });
    } catch (err) {
      throw httpErrorFor(err, UNANSWERABLE_MESSAGE);
    }

    const sources: StoredSource[] = hits.map((hit) => ({
      sourceTable: hit.sourceTable,
      sourceId: hit.sourceId,
      score: hit.score,
    }));
    await this.insertMessage(userId, conversation.id, 'assistant', result.text, sources);

    return { conversationId: conversation.id, reply: result.text, sources };
  }

  /** One conversation, oldest message first. */
  async getConversation(userId: string, conversationId: string) {
    const conversation = await this.loadConversation(userId, conversationId);

    const rows = await withUserContext(this.pool, userId, (db) =>
      db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, conversationId))
        .orderBy(asc(schema.messages.createdAt)),
    );

    return {
      id: conversation.id,
      createdAt: conversation.createdAt,
      messages: rows.map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        // Null on user rows; the sources an assistant reply was grounded
        // in, otherwise — the read side of the same transparency this row
        // was stored for in the first place, per its own schema comment.
        sources: row.retrievedContext,
        createdAt: row.createdAt,
      })),
    };
  }

  private async loadConversation(userId: string, id: string): Promise<ConversationRow> {
    const row = await withUserContext(this.pool, userId, async (db) => {
      const [found] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, id));
      return found;
    });
    // RLS already hides other users' rows, so "not visible" and "does not
    // exist" arrive here as the same thing — same pattern as every other module.
    if (!row) throw new NotFoundException('No such conversation.');
    return row;
  }

  private createConversation(userId: string): Promise<ConversationRow> {
    return withUserContext(this.pool, userId, async (db) => {
      const [row] = await db.insert(schema.conversations).values({ userId }).returning();
      return row;
    });
  }

  private async insertMessage(
    userId: string,
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    sources: StoredSource[] | null,
  ): Promise<void> {
    await withUserContext(this.pool, userId, (db) =>
      db.insert(schema.messages).values({
        userId,
        conversationId,
        role,
        content,
        retrievedContext: sources,
      }),
    );
  }

  /** The last few turns, oldest first — bounded, not the whole conversation. */
  private async recentHistory(userId: string, conversationId: string): Promise<MessageRow[]> {
    const rows = await withUserContext(this.pool, userId, (db) =>
      db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, conversationId))
        .orderBy(desc(schema.messages.createdAt))
        .limit(HISTORY_MESSAGES),
    );
    return rows.reverse();
  }
}

function renderRetrieved(hits: SearchHit[]): string {
  if (hits.length === 0) return '(nothing in her resume or saved vacancies matched this question)';
  return hits.map((hit) => `[${hit.sourceTable}] ${hit.content}`).join('\n\n');
}

function renderHistory(messages: MessageRow[]): string {
  if (messages.length === 0) return '(no prior turns in this conversation)';
  return messages
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n');
}
