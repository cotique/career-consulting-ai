import { Injectable, Logger } from '@nestjs/common';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { SecretsService } from '../config/secrets.service';

export const RESUME_CONTAINER = 'resumes';

/**
 * The only place that talks to blob storage. Business logic goes through this
 * service, for the same reason LLM calls go through `LlmService`: the GCP
 * migration (SPEC §5) should be a second adapter, not a rewrite.
 *
 * Keys are `{userId}/{id}.{ext}`. The user prefix is load-bearing rather than
 * decorative — erasing one person's files is then a single prefix operation
 * instead of an enumeration that can miss a row, and a missed file after a
 * deletion request is personal data that outlived its erasure.
 *
 * No public URLs and no SAS tokens (NFR4): content is streamed back through an
 * authenticated endpoint, so access is decided by the session on every read
 * rather than by whoever holds a link.
 */
@Injectable()
export class BlobStorageService {
  private readonly logger = new Logger(BlobStorageService.name);
  private containerPromise: Promise<ContainerClient> | null = null;

  constructor(private readonly secrets: SecretsService) {}

  private async container(): Promise<ContainerClient> {
    if (!this.containerPromise) {
      this.containerPromise = (async () => {
        const connectionString = await this.secrets.getSecret('AZURE_STORAGE_CONNECTION_STRING');
        const client = BlobServiceClient.fromConnectionString(connectionString);
        const container = client.getContainerClient(RESUME_CONTAINER);
        // Created if absent so a fresh Azurite volume or a fresh account needs
        // no manual step. Access stays private — the default when no access
        // level is passed, and stated here because the alternative is a public
        // container full of resumes.
        await container.createIfNotExists();
        return container;
      })();
    }
    return this.containerPromise;
  }

  /** `{userId}/{id}.{ext}` — see the note on the class about why user-prefixed. */
  static keyFor(userId: string, id: string, extension: string): string {
    const ext = extension.replace(/^\./, '').toLowerCase();
    return `${userId}/${id}${ext ? `.${ext}` : ''}`;
  }

  async upload(key: string, content: Buffer, contentType: string): Promise<void> {
    const container = await this.container();
    await container.getBlockBlobClient(key).uploadData(content, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
  }

  async download(key: string): Promise<Buffer> {
    const container = await this.container();
    return container.getBlockBlobClient(key).downloadToBuffer();
  }

  async exists(key: string): Promise<boolean> {
    const container = await this.container();
    return container.getBlockBlobClient(key).exists();
  }

  /**
   * Deletes everything under a prefix and returns how many blobs went.
   *
   * Used by account deletion, where the count matters: it is the difference
   * between "there was nothing to delete" and "deletion silently did nothing",
   * and those must not look the same in a test that claims erasure works.
   */
  async deleteByPrefix(prefix: string): Promise<number> {
    const container = await this.container();
    let deleted = 0;
    for await (const blob of container.listBlobsFlat({ prefix })) {
      await container.deleteBlob(blob.name);
      deleted++;
    }
    this.logger.log(`Deleted ${deleted} blob(s) under "${prefix}".`);
    return deleted;
  }
}
