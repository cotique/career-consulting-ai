import { Logger } from '@nestjs/common';
import { SecretsService } from '../config/secrets.service';

const logger = new Logger('Telemetry');

/**
 * Wires Azure Monitor (Application Insights) — the answer to "how would a
 * failure be noticed", which the 2026-08-10 architecture review left open.
 *
 * Called before the Nest application is created, because instrumentation has to
 * be in place before the libraries it patches are used. `SecretsService` is
 * constructed directly rather than injected for the same reason: there is no
 * DI container yet at this point, and it has no dependencies of its own.
 *
 * **Telemetry never blocks startup.** If the connection string is absent or the
 * vault can't be reached, this logs and returns. Refusing to start because the
 * system cannot report on itself would trade a working deployment for a
 * monitored one — the wrong way round. The one thing it must not do is fail
 * silently, so both outcomes are logged.
 */
export async function startTelemetry(): Promise<void> {
  if (!process.env.AZURE_KEY_VAULT_URL) {
    logger.log('No Key Vault configured — telemetry off (expected for local runs).');
    return;
  }

  let connectionString: string;
  try {
    connectionString = await new SecretsService().getSecret(
      'APPLICATIONINSIGHTS_CONNECTION_STRING',
    );
  } catch (err) {
    logger.warn(
      `Telemetry not started: ${err instanceof Error ? err.message : String(err)}. ` +
        'The application runs unmonitored — this is a gap, not a failure.',
    );
    return;
  }

  try {
    // Imported lazily so a local run without telemetry never loads the SDK.
    const { useAzureMonitor } = await import('@azure/monitor-opentelemetry');
    useAzureMonitor({
      azureMonitorExporterOptions: { connectionString },
      // Samples are not reduced: at one user the full picture costs nothing,
      // and sampling would make the rare failure the one that goes missing.
      samplingRatio: 1,
    });
    logger.log('Azure Monitor telemetry started.');
  } catch (err) {
    logger.warn(
      `Azure Monitor failed to initialise: ${err instanceof Error ? err.message : String(err)}. ` +
        'Continuing without telemetry.',
    );
  }
}
