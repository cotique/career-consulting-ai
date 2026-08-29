import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { SecretsService } from '../config/secrets.service';

export const SESSION_COOKIE = 'session';
const SESSION_TTL = '30d';

// `jose` is ESM-only; this project emits CommonJS, where a static import
// becomes require() and throws ERR_REQUIRE_ESM. A real dynamic import works
// from CJS — tsconfig uses module: node16 so TypeScript preserves it instead
// of downleveling it back to require(). Node caches the module after the
// first load, so the repeated await costs nothing.
const importJose = () => import('jose');

/**
 * Stateless sessions: a signed JWT in an httpOnly cookie, no server-side
 * store. Chosen so there is no session state to lose across restarts and
 * nothing sticky for a scale-to-zero container deployment, where instances
 * come and go between requests.
 *
 * Known tradeoff (see "Deliberately deferred" in docs/ARCHITECTURE.md): a
 * session cannot be revoked
 * before it expires. Acceptable for a single dogfood user; revisit before
 * external users, when revocation and device management start to matter.
 */
@Injectable()
export class SessionService {
  private key: Uint8Array | null = null;

  constructor(private readonly secrets: SecretsService) {}

  private async signingKey(): Promise<Uint8Array> {
    if (!this.key) {
      const secret = await this.secrets.getSecret('SESSION_SECRET');
      this.key = new TextEncoder().encode(secret);
    }
    return this.key;
  }

  async issue(res: Response, userId: string): Promise<void> {
    const { SignJWT } = await importJose();
    const token = await new SignJWT({ sub: userId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(SESSION_TTL)
      .sign(await this.signingKey());

    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      // Cookies are only marked Secure over HTTPS — locally the API runs on
      // plain http://localhost, where a Secure cookie would never be sent back.
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });
  }

  /** Returns the user id, or null if the cookie is absent, tampered with, or expired. */
  async verify(token: string | undefined): Promise<string | null> {
    if (!token) return null;
    try {
      const { jwtVerify } = await importJose();
      const { payload } = await jwtVerify(token, await this.signingKey());
      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }

  clear(res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }
}
