import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretsService, isSecretNotFoundError, keyVaultName } from './secrets.service';

// Regression test for a real confusion: a failing credential chain surfaced as
// `Secret "DATABASE_URL" not found`, so the search went to the vault contents
// instead of to authentication. "Missing secret" and "could not ask the vault"
// are fixed in completely different places, so they must not share a message.
describe('Key Vault failure classification', () => {
  it('treats a genuine missing secret as not-found', () => {
    expect(isSecretNotFoundError({ code: 'SecretNotFound', statusCode: 404 })).toBe(true);
    expect(
      isSecretNotFoundError(new Error('A secret with (name/id) x was not found in this key vault.')),
    ).toBe(true);
  });

  it('does NOT treat an authentication failure as a missing secret', () => {
    const authFailure = new Error(
      'AggregateAuthenticationError: ChainedTokenCredential authentication failed.',
    );
    expect(isSecretNotFoundError(authFailure)).toBe(false);
  });

  it('does NOT treat a network or authorization failure as a missing secret', () => {
    expect(isSecretNotFoundError(new Error('getaddrinfo ENOTFOUND vault.azure.net'))).toBe(false);
    expect(isSecretNotFoundError({ code: 'Forbidden', statusCode: 403 })).toBe(false);
  });
});

describe('Key Vault name mapping', () => {
  // Key Vault rejects underscores in secret names outright, so an unmapped
  // name fails at deploy time and nowhere earlier — worth pinning in a test.
  it('converts env-var names to the vault spelling', () => {
    expect(keyVaultName('DATABASE_URL')).toBe('database-url');
    expect(keyVaultName('GOOGLE_CLIENT_SECRET')).toBe('google-client-secret');
    expect(keyVaultName('SESSION_SECRET')).toBe('session-secret');
  });

  it('leaves an already-valid name alone', () => {
    expect(keyVaultName('database-url')).toBe('database-url');
  });
});

describe('SecretsService (env fallback — no AZURE_KEY_VAULT_URL set)', () => {
  const ENV_KEY = 'TEST_SECRET_FOR_SPEC';

  beforeEach(() => {
    delete process.env.AZURE_KEY_VAULT_URL;
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it('reads from process.env when no Key Vault is configured', async () => {
    process.env[ENV_KEY] = 'a-local-dev-value';
    const service = new SecretsService();

    await expect(service.getSecret(ENV_KEY)).resolves.toBe('a-local-dev-value');
  });

  it('throws a clear error when the secret is missing everywhere', async () => {
    const service = new SecretsService();

    await expect(service.getSecret('DOES_NOT_EXIST')).rejects.toThrow(
      /not found/,
    );
  });

  it('caches a resolved value instead of re-reading process.env', async () => {
    process.env[ENV_KEY] = 'first-value';
    const service = new SecretsService();
    await service.getSecret(ENV_KEY);

    process.env[ENV_KEY] = 'second-value';
    await expect(service.getSecret(ENV_KEY)).resolves.toBe('first-value');
  });
});
