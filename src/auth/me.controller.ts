import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { withUserContext } from '../db/user-context';
import * as schema from '../db/schema';
import { deleteUserData, exportUserData } from '../db/user-data';
import { BlobStorageService } from '../storage/blob-storage.service';
import { AuthGuard } from './auth.guard';
import { CurrentUser } from './current-user.decorator';
import { SessionService } from './session.service';

/**
 * Account routes (FR5). The delete/export logic itself was built and tested in
 * Epic 1 — this wires it to routes now that there's an authenticated caller to
 * attribute the request to.
 */
@ApiTags('me')
@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly sessions: SessionService,
    // Storage directly rather than through the resumes module: account deletion
    // must not make auth depend on a domain module, and blob keys are prefixed
    // by user id precisely so erasure needs no knowledge of what was stored.
    private readonly blobs: BlobStorageService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Current user and profile' })
  async me(@CurrentUser() userId: string) {
    return withUserContext(this.pool, userId, async (db) => {
      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
      const [profile] = await db
        .select()
        .from(schema.userProfiles)
        .where(eq(schema.userProfiles.userId, userId));
      return { user, profile: profile ?? null };
    });
  }

  @Get('export')
  @ApiOperation({
    summary: 'Export all data held about you',
    description: 'Everything under this account, as JSON (FR5/NFR6).',
  })
  async export(@CurrentUser() userId: string) {
    return withUserContext(this.pool, userId, (db) => exportUserData(db, userId));
  }

  @Delete()
  @ApiOperation({
    summary: 'Delete this account and all its data',
    description:
      'Irreversible: cascades to every table owned by the account. Requires confirm=DELETE.',
  })
  @ApiQuery({ name: 'confirm', required: true, example: 'DELETE' })
  async deleteAccount(
    @CurrentUser() userId: string,
    @Res({ passthrough: true }) res: Response,
    @Query('confirm') confirm?: string,
  ) {
    // A destructive, unrecoverable action shouldn't be one stray click away —
    // the explicit token makes it a deliberate act rather than an accident.
    if (confirm !== 'DELETE') {
      throw new BadRequestException('Add ?confirm=DELETE to confirm this irreversible deletion.');
    }

    // Blobs first, database second — and the order is not stylistic. Once the
    // cascade has run there is no record of which blobs belonged to this user,
    // so a failure after the rows are gone would leave their files unreachable
    // and undeletable.
    //
    // If blob deletion throws, this request aborts and the database is left
    // intact. That direction is chosen deliberately: a surviving file is
    // personal data that outlived an erasure request, while a row pointing at a
    // missing file is a broken read. Fail towards the broken read.
    const blobsDeleted = await this.blobs.deleteByPrefix(`${userId}/`);

    await withUserContext(this.pool, userId, (db) => deleteUserData(db, userId));
    this.sessions.clear(res);
    return { deleted: true, blobsDeleted };
  }
}
