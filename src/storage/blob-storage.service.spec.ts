import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { SecretsService } from '../config/secrets.service';
import { BlobStorageService } from './blob-storage.service';

/**
 * Integration: the real Azure Blob SDK against Azurite (docker-compose, T2).
 * Not mocked — the SDK is the part with the behavior worth testing, and a mock
 * of it would only assert that we called our own stub.
 *
 * SecretsService is constructed directly: with no AZURE_KEY_VAULT_URL set it
 * reads AZURE_STORAGE_CONNECTION_STRING from the env, which is what local dev
 * does. Nest DI adds nothing here.
 */
const storage = new BlobStorageService(new SecretsService());

/** Fresh per test, so a leftover blob from a previous run can never make one pass. */
const prefixes: string[] = [];
function freshUser(): string {
  const id = randomUUID();
  prefixes.push(`${id}/`);
  return id;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

afterAll(async () => {
  for (const prefix of prefixes) {
    await storage.deleteByPrefix(prefix);
  }
});

describe('BlobStorageService against Azurite', () => {
  it('round-trips arbitrary bytes without altering one of them', async () => {
    const userId = freshUser();
    const key = BlobStorageService.keyFor(userId, randomUUID(), 'pdf');
    // Random bytes, not a string: a PDF is not valid UTF-8, and a round trip
    // that decodes to a string anywhere along the way corrupts it silently
    // while still returning "a file". A hash is the only assertion that notices.
    const content = randomBytes(64 * 1024);

    await storage.upload(key, content, 'application/pdf');
    const downloaded = await storage.download(key);

    expect(sha256(downloaded)).toBe(sha256(content));
    expect(downloaded.length).toBe(content.length);
  });

  it('reports existence honestly in both directions', async () => {
    const userId = freshUser();
    const key = BlobStorageService.keyFor(userId, randomUUID(), 'txt');

    expect(await storage.exists(key)).toBe(false);
    await storage.upload(key, Buffer.from('a resume'), 'text/plain');
    expect(await storage.exists(key)).toBe(true);
  });

  it('deletes everything under one user and nothing under another', async () => {
    const mine = freshUser();
    const theirs = freshUser();

    const myKeys = [
      BlobStorageService.keyFor(mine, randomUUID(), 'pdf'),
      BlobStorageService.keyFor(mine, randomUUID(), 'docx'),
    ];
    const theirKey = BlobStorageService.keyFor(theirs, randomUUID(), 'pdf');
    for (const key of [...myKeys, theirKey]) {
      await storage.upload(key, Buffer.from(key), 'application/pdf');
    }

    // The trailing slash is the part under test. `deleteByPrefix(userId)`
    // without it would be a substring match over blob names — harmless while
    // ids are uuids, and a cross-account deletion the moment they are not.
    const deleted = await storage.deleteByPrefix(`${mine}/`);

    expect(deleted).toBe(2);
    for (const key of myKeys) {
      expect(await storage.exists(key)).toBe(false);
    }
    expect(await storage.exists(theirKey)).toBe(true);
  });

  it('returns 0 rather than pretending to have deleted something', async () => {
    // The distinction the service's own comment turns on: "there was nothing to
    // delete" and "deletion silently did nothing" must not look identical to a
    // test that claims erasure works.
    expect(await storage.deleteByPrefix(`${freshUser()}/`)).toBe(0);
  });

  it('overwrites in place when the same key is uploaded twice', async () => {
    const userId = freshUser();
    const key = BlobStorageService.keyFor(userId, randomUUID(), 'txt');

    await storage.upload(key, Buffer.from('first version'), 'text/plain');
    await storage.upload(key, Buffer.from('second version'), 'text/plain');

    // Versioning is deliberately off (NFR16: no recovery mechanism may outlive a
    // deletion request), so an overwrite must leave exactly one copy — not an
    // older version quietly retrievable behind it.
    expect((await storage.download(key)).toString()).toBe('second version');
    expect(await storage.deleteByPrefix(`${userId}/`)).toBe(1);
  });
});
