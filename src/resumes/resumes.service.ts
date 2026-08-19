import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { withUserContext } from '../db/user-context';
import * as schema from '../db/schema';
import { httpErrorFor } from '../llm/llm-http';
import { LlmService } from '../llm/llm.service';
import { RESUME_TEXT } from '../llm/templates';
import { BlobStorageService } from '../storage/blob-storage.service';
import { ACCEPTED_MIME_TYPES, MAX_UPLOAD_BYTES, extensionFor, extractText } from './extract-text';
import { ResumeStructureSchema, hasExtractedSubstance } from './resume-schema';

/**
 * One message for every way a resume can fail to become a structure — a schema
 * mismatch, a truncated answer, an answer with nothing in it. They differ for
 * us and are logged separately; to the person holding the file they are the same
 * fact, and the useful half is the advice, not the cause.
 */
const UNREADABLE_RESUME =
  'Could not read that resume into a usable structure. The file may be a scan, or laid out in a way the parser mangles — a plainer version usually works.';

@Injectable()
export class ResumesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly blobs: BlobStorageService,
    private readonly llm: LlmService,
  ) {}

  /**
   * Stores the raw file and its row, then deactivates the user's other resumes.
   *
   * Exactly one resume is active per user (FR4): scoring and tailoring always
   * read the active one, and superseded rows are kept — never read — so
   * self-audit can tell which version a tailored document came from.
   *
   * No row may ever point at a file that was never stored — that reads as data
   * loss and there is nothing to recover. The guarantee comes from the
   * transaction, not from the ordering: the row is inserted first to obtain the
   * id the blob key needs, and if the upload throws, the insert rolls back with
   * it. What this can leave behind instead is an unreferenced blob, which is
   * the harmless direction and which account deletion removes anyway, because
   * erasure works by user prefix rather than by row.
   */
  async upload(
    userId: string,
    file: { buffer: Buffer; mimetype: string; size: number },
  ): Promise<{ id: string; mimeType: string; isActive: boolean }> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded.');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException(
        `That file is ${Math.round(file.size / 1024 / 1024)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
      );
    }
    const extension = extensionFor(file.mimetype);

    return withUserContext(this.pool, userId, async (db) => {
      const [row] = await db
        .insert(schema.resumes)
        .values({
          userId,
          // Placeholder: the key needs the row's own id, which the database
          // generates. Overwritten immediately below, inside the same
          // transaction, so no other reader ever observes this value.
          blobStoragePath: 'pending',
          mimeType: file.mimetype,
          isActive: true,
        })
        .returning();

      const key = BlobStorageService.keyFor(userId, row.id, extension);
      await this.blobs.upload(key, file.buffer, file.mimetype);

      await db
        .update(schema.resumes)
        .set({ blobStoragePath: key })
        .where(eq(schema.resumes.id, row.id));

      await db
        .update(schema.resumes)
        .set({ isActive: false })
        .where(and(eq(schema.resumes.userId, userId), ne(schema.resumes.id, row.id)));

      return { id: row.id, mimeType: row.mimeType, isActive: true };
    });
  }

  /**
   * Metadata plus the extraction state of each resume (FR4). The state is part
   * of the resource rather than something a caller infers from a second
   * request: an uploaded file with no structure yet is an ordinary condition,
   * and a list that omitted it would present an un-extracted resume as ready.
   */
  async list(userId: string) {
    return withUserContext(this.pool, userId, async (db) => {
      const resumes = await db
        .select()
        .from(schema.resumes)
        .where(eq(schema.resumes.userId, userId))
        .orderBy(desc(schema.resumes.uploadedAt));

      const extractions = await db
        .select({
          resumeId: schema.resumeExtractions.resumeId,
          extractedAt: schema.resumeExtractions.extractedAt,
          promptVersion: schema.resumeExtractions.promptVersion,
        })
        .from(schema.resumeExtractions)
        .where(eq(schema.resumeExtractions.userId, userId))
        // Nothing stops a resume having several extractions — `POST :id/extract`
        // can be called again, deliberately, after a prompt revision. Oldest
        // first so the map below ends up holding the newest per resume; without
        // an order the reported prompt version was whichever row the planner
        // happened to return last.
        .orderBy(schema.resumeExtractions.extractedAt);

      const byResume = new Map(extractions.map((e) => [e.resumeId, e]));
      return resumes.map((r) => {
        const extraction = byResume.get(r.id);
        return {
          id: r.id,
          mimeType: r.mimeType,
          isActive: r.isActive,
          uploadedAt: r.uploadedAt,
          extraction: extraction
            ? { state: 'extracted' as const, at: extraction.extractedAt, promptVersion: extraction.promptVersion }
            : { state: 'not_extracted' as const },
        };
      });
    });
  }

  /** Streams the stored file back. Scoped by session user, never by a link (NFR4). */
  async content(userId: string, resumeId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const resume = await withUserContext(this.pool, userId, async (db) => {
      const [row] = await db
        .select()
        .from(schema.resumes)
        .where(eq(schema.resumes.id, resumeId));
      return row;
    });

    // RLS already hides other users' rows, so "not visible" and "does not
    // exist" arrive here as the same thing — and are answered the same way,
    // which is also what stops this endpoint from confirming that someone
    // else's resume id exists.
    if (!resume) throw new NotFoundException('No such resume.');

    return { buffer: await this.blobs.download(resume.blobStoragePath), mimeType: resume.mimeType };
  }

  /**
   * Extracts the structure of a stored resume.
   *
   * Takes identifiers only, no content — which is a pg-boss handler's exact
   * signature and the payload convention it must obey (IDs never content, so a
   * queue row can't outlive a user's delete-cascade). It runs synchronously
   * today only because pg-boss arrives with T20; wrapping it then is mechanical.
   */
  async extractResume(userId: string, resumeId: string) {
    const resume = await withUserContext(this.pool, userId, async (db) => {
      const [row] = await db.select().from(schema.resumes).where(eq(schema.resumes.id, resumeId));
      return row;
    });
    if (!resume) throw new NotFoundException('No such resume.');

    const file = await this.blobs.download(resume.blobStoragePath);
    const text = await extractText(file, resume.mimeType);

    // Deliberately outside any transaction of ours. The LLM layer opens its own
    // short ones for the spend guards and the usage log, which is what keeps a
    // record of money we spent from being rolled back by a failure here — and
    // it keeps a pooled connection from being held open across a model call.
    let extracted;
    try {
      extracted = await this.llm.completeStructured(
        {
          template: 'resume_extract',
          userId,
          // The resume is untrusted input: it is a document from outside the
          // system, and the rendering layer wraps it in data delimiters so it
          // cannot act as instructions.
          untrusted: { [RESUME_TEXT]: text },
        },
        ResumeStructureSchema,
      );
    } catch (err) {
      throw httpErrorFor(err, UNREADABLE_RESUME);
    }

    // Every field in the schema is optional or defaulted, so `{}` validates and
    // arrives here as a person with no experience, no education and no skills.
    // Storing that would turn "the model told us nothing" into an assertion
    // about someone's career, and the list endpoint would then report it as
    // extracted. Absence of an answer is not an answer.
    if (!hasExtractedSubstance(extracted.data)) {
      throw new BadRequestException(UNREADABLE_RESUME);
    }

    return withUserContext(this.pool, userId, async (db) => {
      const [saved] = await db
        .insert(schema.resumeExtractions)
        .values({
          userId,
          resumeId,
          structuredJson: extracted.data,
          modelUsed: extracted.model,
          promptVersion: extracted.promptVersion,
        })
        .returning();
      return saved;
    });
  }

  static acceptedMimeTypes(): string[] {
    return [...ACCEPTED_MIME_TYPES.keys()];
  }
}
