import { Injectable, Logger } from '@nestjs/common';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

/**
 * Key Vault secret names allow only letters, digits and hyphens. Callers use
 * the environment-variable name everywhere (`DATABASE_URL`); this is the one
 * place that knows the vault spells it `database-url`.
 */
export function keyVaultName(envName: string): string {
  return envName.toLowerCase().replace(/_/g, '-');
}

/**
 * Whether a Key Vault failure means "no such secret" as opposed to "could not
 * ask". Exported so it can be tested directly: the distinction is the whole
 * diagnosis, and it was wrong once already — a failing credential chain
 * reported a missing secret and sent us hunting for something that was sitting
 * in the vault the whole time.
 */
export function isSecretNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  return (
    code === 'SecretNotFound' ||
    status === 404 ||
    /SecretNotFound|was not found in this key vault/i.test(message)
  );
}

/**
 * Single point for reading secrets: Azure Key Vault when AZURE_KEY_VAULT_URL
 * is set (deployed environments), a plain env var otherwise (local dev, .env
 * — see ARCHITECTURE.md's NFR3 and .env.example). Never read process.env
 * directly for anything secret-shaped outside this service.
 */
@Injectable()
export class SecretsService {
  private readonly logger = new Logger(SecretsService.name);
  private readonly client: SecretClient | null;
  private readonly cache = new Map<string, string>();

  constructor() {
    const vaultUrl = process.env.AZURE_KEY_VAULT_URL;
    this.client = vaultUrl
      ? new SecretClient(vaultUrl, new DefaultAzureCredential())
      : null;
  }

  /**
   * @param name The environment-variable name (e.g. "DATABASE_URL"). Callers
   *   use one name for both backends; the Key Vault name is derived, because
   *   Key Vault secret names may only contain alphanumerics and hyphens —
   *   underscores are rejected outright, so passing the env name straight
   *   through would fail at deploy time and not before.
   */
  async getSecret(name: string): Promise<string> {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const value = this.client
      ? await this.fetchFromKeyVault(keyVaultName(name))
      : process.env[name];

    if (!value) {
      throw new Error(`Secret "${name}" not found (checked environment variables).`);
    }

    this.cache.set(name, value);
    return value;
  }

  /**
   * Distinguishes "the vault says there is no such secret" from "we could not
   * ask the vault". The difference is the whole diagnosis: the first is a
   * missing secret, the second is authentication or networking, and they are
   * fixed in completely different places.
   *
   * This mattered immediately: a failing credential chain used to surface as
   * `Secret "DATABASE_URL" not found`, sending you to look for a secret that
   * was sitting in the vault the whole time.
   */
  private async fetchFromKeyVault(name: string): Promise<string> {
    let secretValue: string | undefined;

    try {
      secretValue = (await this.client!.getSecret(name)).value;
    } catch (err) {
      // Only the *call* is guarded here. An earlier version also threw the
      // empty-value error inside this try, where its own catch re-labelled it
      // as "could not reach Key Vault" — a vault we had just reached.
      const notFound = isSecretNotFoundError(err);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        notFound
          ? `Key Vault has no secret named "${name}".`
          : `Could not read secret "${name}" from Key Vault — an access or connectivity failure, not a missing secret.`,
        err as Error,
      );
      throw new Error(
        notFound
          ? `Secret "${name}" is not present in Key Vault.`
          : `Could not reach Key Vault to read "${name}": ${message}`,
        { cause: err },
      );
    }

    if (!secretValue) {
      throw new Error(`Key Vault secret "${name}" exists but holds no value.`);
    }
    return secretValue;
  }
}
