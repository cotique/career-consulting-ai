import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

/**
 * Probes for the hosting platform (T49). Both are deliberately
 * unauthenticated — a probe cannot hold a session.
 *
 * The split matters, and conflating the two is the usual mistake:
 *
 * - **Liveness** answers "is this process wedged?" and must NOT check
 *   dependencies. If it failed while Postgres was down, the platform would
 *   restart a perfectly healthy container in a loop and fix nothing.
 * - **Readiness** answers "should traffic go here?" and therefore does check
 *   the database, returning 503 so the platform stops routing rather than
 *   serving requests that will fail. A readiness endpoint that answers 200
 *   with a "degraded" body is indistinguishable from healthy to a probe, which
 *   makes it decoration.
 *
 * Neither discloses anything about the database beyond reachability.
 */
// Exempt from rate limiting: the platform probes these continuously, so a
// limit here would turn a healthy deployment into a flapping one.
@SkipThrottle()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  @ApiOperation({ summary: 'Liveness — the process is running. No dependency checks.' })
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness — 200 if the database is reachable, 503 if not' })
  async ready(): Promise<{ status: string; database: string }> {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'not_ready', database: 'unreachable' });
    }
    return { status: 'ok', database: 'up' };
  }
}
