import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { withUserContext } from '../db/user-context';
import * as schema from '../db/schema';
import { JOB_NAMES } from '../jobs/job-name';
import { JobQueueService } from '../jobs/job-queue.service';
import type { CreateApplicationDto, TransitionApplicationDto } from './tracker.dto';
import { APPLICATION_STATUSES, assertTransition, type ApplicationStatus } from './tracker-transitions';

/** No config surface for one number — a solo-dogfood default, not a tunable. */
const FOLLOW_UP_DELAY_SECONDS = 14 * 24 * 60 * 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ApplicationRow = typeof schema.applications.$inferSelect;

interface FollowUpJobPayload {
  applicationId: string;
  userId: string;
}

function isApplicationStatus(value: string): value is ApplicationStatus {
  return (APPLICATION_STATUSES as readonly string[]).includes(value);
}

@Injectable()
export class TrackerService implements OnModuleInit {
  private readonly logger = new Logger(TrackerService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly jobQueue: JobQueueService,
  ) {}

  /**
   * The tracker is pg-boss's first real consumer (T20's own doc comment
   * anticipates this). Registered once, here, for the app's lifetime —
   * calling `registerHandler` more than once against the same queue starts a
   * second poller competing with the first for the same rows (the exact race
   * T20's own test suite hit).
   */
  async onModuleInit(): Promise<void> {
    await this.jobQueue.registerHandler<FollowUpJobPayload>(JOB_NAMES.TRACKER_FOLLOW_UP, (job) =>
      this.handleFollowUp(job.data),
    );
  }

  /** Starts tracking an already-intake'd vacancy (FR22). */
  async create(userId: string, dto: CreateApplicationDto) {
    const vacancyId = dto.vacancyId;
    // Every other entity id in this app arrives as a path param through
    // ParseUUIDPipe; this is the first to arrive in a body, where nothing
    // upstream validates its shape — an unchecked malformed value reaches
    // Postgres as a raw type error (500) instead of this app's usual 400.
    if (!UUID_RE.test(vacancyId)) {
      throw new BadRequestException('vacancyId must be a UUID.');
    }

    return withUserContext(this.pool, userId, async (db) => {
      const [vacancy] = await db
        .select({ id: schema.vacancies.id })
        .from(schema.vacancies)
        .where(eq(schema.vacancies.id, vacancyId));
      // RLS already hides other users' rows, so "not visible" and "does not
      // exist" arrive here as the same thing — same pattern as intake/scoring.
      if (!vacancy) throw new NotFoundException('No such vacancy.');

      const [row] = await db.insert(schema.applications).values({ userId, vacancyId }).returning();
      await db.insert(schema.applicationEvents).values({
        userId,
        applicationId: row.id,
        eventType: 'created',
        payload: { vacancyId },
      });

      return this.view(row);
    });
  }

  /** The user's tracked applications, most recently updated first. */
  async list(userId: string, { status }: { status?: string } = {}) {
    if (status !== undefined && !isApplicationStatus(status)) {
      throw new BadRequestException(`Unknown status "${status}".`);
    }

    const rows = await withUserContext(this.pool, userId, (db) =>
      db
        .select()
        .from(schema.applications)
        .where(
          status
            ? and(eq(schema.applications.userId, userId), eq(schema.applications.status, status))
            : eq(schema.applications.userId, userId),
        )
        .orderBy(desc(schema.applications.updatedAt)),
    );

    return rows.map((row) => this.view(row));
  }

  /** One application with its event timeline, oldest first. */
  async get(userId: string, id: string) {
    const application = await this.load(userId, id);

    const events = await withUserContext(this.pool, userId, (db) =>
      db
        .select()
        .from(schema.applicationEvents)
        .where(eq(schema.applicationEvents.applicationId, id))
        .orderBy(asc(schema.applicationEvents.occurredAt)),
    );

    return {
      ...this.view(application),
      events: events.map((event) => ({
        eventType: event.eventType,
        payload: event.payload,
        occurredAt: event.occurredAt,
      })),
    };
  }

  /**
   * Moves an application to a new status (FR22). Every transition writes an
   * `application_events` row; a transition into `applied` also enqueues the
   * one real pg-boss job this task adds — a delayed follow-up reminder. A
   * later transition away from `applied` does not cancel that job
   * (`JobQueueService` has no cancel-by-key mechanism): it fires anyway and
   * no-ops, which is the accepted behavior, not a bug.
   */
  async transition(userId: string, id: string, dto: TransitionApplicationDto) {
    if (!isApplicationStatus(dto.status)) {
      throw new BadRequestException(`Unknown status "${dto.status}".`);
    }
    const to = dto.status;

    const application = await this.load(userId, id);
    const from = application.status;
    assertTransition(from, to);

    const updated = await withUserContext(this.pool, userId, async (db) => {
      // The read above and this write are two separate transactions — a
      // second request could have changed the status in between. The update
      // is conditioned on the status still being what we read (`from`);
      // zero rows back means we lost that race, not that the row vanished.
      const [row] = await db
        .update(schema.applications)
        .set({
          status: to,
          updatedAt: new Date(),
          ...(to === 'applied' ? { appliedAt: new Date() } : {}),
        })
        .where(and(eq(schema.applications.id, id), eq(schema.applications.status, from)))
        .returning();

      if (!row) {
        throw new ConflictException(
          'This application was changed by another request in the meantime — reload and try again.',
        );
      }

      await db.insert(schema.applicationEvents).values({
        userId,
        applicationId: id,
        eventType: 'status_changed',
        payload: { fromStatus: from, toStatus: to, note: dto.note ?? null },
      });

      return row;
    });

    if (to === 'applied') {
      // The status change above already committed — it is the fact of
      // record. A reminder that never got scheduled is exactly as harmless
      // as one that fires late and finds nothing to do (see this class's own
      // `handleFollowUp`), so a failure here must not turn an already-real
      // transition into a client-visible error.
      try {
        await this.jobQueue.enqueue(
          JOB_NAMES.TRACKER_FOLLOW_UP,
          { applicationId: id, userId },
          { startAfter: FOLLOW_UP_DELAY_SECONDS },
        );
      } catch (err) {
        this.logger.error('Failed to enqueue the follow-up reminder job.', err as Error);
      }
    }

    return this.view(updated);
  }

  /**
   * pg-boss delivery is at-least-once, so this must tolerate re-firing — a
   * second `follow_up_due` row for the same reminder is an accepted side
   * effect, not something this guards against.
   */
  private async handleFollowUp({ applicationId, userId }: FollowUpJobPayload): Promise<void> {
    await withUserContext(this.pool, userId, async (db) => {
      const [row] = await db
        .select()
        .from(schema.applications)
        .where(eq(schema.applications.id, applicationId));

      if (!row || row.status !== 'applied') return;

      await db.insert(schema.applicationEvents).values({
        userId,
        applicationId,
        eventType: 'follow_up_due',
      });
    });
  }

  private async load(userId: string, id: string): Promise<ApplicationRow> {
    const row = await withUserContext(this.pool, userId, async (db) => {
      const [found] = await db.select().from(schema.applications).where(eq(schema.applications.id, id));
      return found;
    });
    if (!row) throw new NotFoundException('No such application.');
    return row;
  }

  private view(row: ApplicationRow) {
    return {
      id: row.id,
      vacancyId: row.vacancyId,
      status: row.status,
      appliedAt: row.appliedAt,
      updatedAt: row.updatedAt,
    };
  }
}
