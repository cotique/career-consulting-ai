import { Injectable } from '@nestjs/common';
// `resolution-mode: import` — required for a type-only import of an ESM
// package from a CommonJS file under module: node16.
import type * as OpenIdClient from 'openid-client' with { 'resolution-mode': 'import' };
import { SecretsService } from '../config/secrets.service';
import type { ProviderIdentity } from './identity.service';

const GOOGLE_ISSUER = 'https://accounts.google.com';

// openid-client v6 is ESM-only — loaded dynamically for the same reason as
// `jose` in session.service.ts (see the note there). The type-only import
// above keeps full type checking on the dynamic value.
const importOpenIdClient = (): Promise<typeof OpenIdClient> => import('openid-client');

export interface AuthorizationStart {
  url: string;
  state: string;
  codeVerifier: string;
}

/**
 * Google sign-in via `openid-client` (a certified OIDC implementation) rather
 * than hand-rolled HTTP calls: PKCE, `state`, and — most importantly — ID
 * token verification against Google's rotating JWKS are handled by the
 * library. Decoding an ID token without verifying its signature, issuer and
 * audience is the classic way to accept a forged one.
 */
@Injectable()
export class GoogleOAuthService {
  private configPromise: Promise<OpenIdClient.Configuration> | null = null;

  constructor(private readonly secrets: SecretsService) {}

  private async config(): Promise<OpenIdClient.Configuration> {
    if (!this.configPromise) {
      this.configPromise = (async () => {
        const client = await importOpenIdClient();
        const clientId = await this.secrets.getSecret('GOOGLE_CLIENT_ID');
        const clientSecret = await this.secrets.getSecret('GOOGLE_CLIENT_SECRET');
        return client.discovery(new URL(GOOGLE_ISSUER), clientId, clientSecret);
      })();
    }
    return this.configPromise;
  }

  private redirectUri(): string {
    const base = process.env.APP_BASE_URL ?? 'http://localhost:3000';
    return `${base}/auth/google/callback`;
  }

  async startAuthorization(): Promise<AuthorizationStart> {
    const client = await importOpenIdClient();
    const config = await this.config();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();

    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri(),
      scope: 'openid email profile',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });

    return { url: url.href, state, codeVerifier };
  }

  /**
   * Exchanges the callback for tokens. The library checks the returned
   * `state` against `expectedState` and validates the ID token; a mismatch or
   * an invalid token throws rather than returning a partial result.
   */
  async completeAuthorization(
    currentUrl: URL,
    expectedState: string,
    codeVerifier: string,
  ): Promise<ProviderIdentity> {
    const client = await importOpenIdClient();
    const config = await this.config();
    const tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState,
    });

    const claims = tokens.claims();
    if (!claims?.sub) {
      throw new Error('Google ID token has no subject claim.');
    }

    return {
      provider: 'google',
      externalId: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : undefined,
      name: typeof claims.name === 'string' ? claims.name : undefined,
    };
  }
}
