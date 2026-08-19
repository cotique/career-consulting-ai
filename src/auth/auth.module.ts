import { Global, Module } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL, unscopedDb, type Database } from '../db/db.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { GoogleOAuthService } from './google-oauth.service';
import { IdentityService } from './identity.service';
import { MeController } from './me.controller';
import { SessionService } from './session.service';
import { UNSCOPED_DB_SIGN_IN_ONLY } from './unscoped-db.token';

// Global so other modules can apply AuthGuard without importing this module.
// The unscoped connection is provided here and exported nowhere — see the note
// on the token itself.
@Global()
@Module({
  controllers: [AuthController, MeController],
  providers: [
    {
      provide: UNSCOPED_DB_SIGN_IN_ONLY,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Database => unscopedDb(pool),
    },
    GoogleOAuthService,
    IdentityService,
    SessionService,
    AuthGuard,
  ],
  exports: [SessionService, AuthGuard],
})
export class AuthModule {}
