import { Controller, Get, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { GoogleOAuthService } from './google-oauth.service';
import { IdentityService } from './identity.service';
import { SessionService } from './session.service';

const OAUTH_STATE_COOKIE = 'oauth_state';
const OAUTH_VERIFIER_COOKIE = 'oauth_verifier';
const OAUTH_TX_MAX_AGE_MS = 10 * 60 * 1000;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly google: GoogleOAuthService,
    private readonly identities: IdentityService,
    private readonly sessions: SessionService,
  ) {}

  @Get('google')
  @ApiOperation({
    summary: 'Start Google sign-in',
    description: 'Redirects to Google. Open this in a browser, not via curl.',
  })
  async startGoogle(@Res() res: Response): Promise<void> {
    const { url, state, codeVerifier } = await this.google.startAuthorization();

    // state (CSRF) and the PKCE verifier have to survive the round trip to
    // Google. httpOnly cookies keep them out of reach of page scripts; they
    // expire in minutes because they are single-use transaction state.
    const options = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      maxAge: OAUTH_TX_MAX_AGE_MS,
      path: '/auth',
    };
    res.cookie(OAUTH_STATE_COOKIE, state, options);
    res.cookie(OAUTH_VERIFIER_COOKIE, codeVerifier, options);
    res.redirect(url);
  }

  @Get('google/callback')
  @ApiExcludeEndpoint() // Google redirects here; not something to call by hand.
  async googleCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const cookies = (req.cookies ?? {}) as Record<string, string>;
    const expectedState = cookies[OAUTH_STATE_COOKIE];
    const codeVerifier = cookies[OAUTH_VERIFIER_COOKIE];

    if (!expectedState || !codeVerifier) {
      // No transaction cookies means this callback didn't originate from a
      // flow we started — the exact shape of a CSRF attempt.
      throw new UnauthorizedException('No pending sign-in. Start again at /auth/google.');
    }

    const base = process.env.APP_BASE_URL ?? 'http://localhost:3000';
    const currentUrl = new URL(req.originalUrl, base);

    // Throws if `state` doesn't match or the ID token fails verification.
    const identity = await this.google.completeAuthorization(
      currentUrl,
      expectedState,
      codeVerifier,
    );

    const userId = await this.identities.findOrCreateUser(identity);

    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth' });
    res.clearCookie(OAUTH_VERIFIER_COOKIE, { path: '/auth' });
    await this.sessions.issue(res, userId);

    res.json({ signedIn: true, userId });
  }

  @Get('logout')
  @ApiOperation({ summary: 'Clear the session cookie' })
  logout(@Res() res: Response, @Query('redirect') redirect?: string): void {
    this.sessions.clear(res);
    if (redirect) {
      res.redirect(redirect);
      return;
    }
    res.json({ signedOut: true });
  }
}
