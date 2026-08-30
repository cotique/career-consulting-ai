import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { CONTACTS_FIELD, stripContacts } from '../llm/scrub';
import { BlobStorageService } from '../storage/blob-storage.service';
import { ACCEPTED_MIME_TYPES, MAX_UPLOAD_BYTES, extensionFor, extractText } from './extract-text';
import { ResumeStructureSchema } from './resume-schema';
import { ResumesService } from './resumes.service';

/**
 * Unit half of T15's verification: the checks that must hold before anything is
 * stored, and the contact-stripping contract the extraction schema was shaped
 * around. Everything here is pure — no Postgres, no Azurite.
 */

/**
 * Records what it was asked to store, and is never expected to be asked.
 * A validation test that only asserts "it threw" would still pass if the
 * rejection happened *after* the file had been written, which is the failure
 * that actually matters: a refused resume that is nonetheless sitting in
 * storage is personal data nobody has a row for and erasure cannot find.
 */
class RecordingBlobs {
  readonly uploaded: string[] = [];
  async upload(key: string): Promise<void> {
    this.uploaded.push(key);
  }
}

/**
 * Any property access throws. Passed where the real pg Pool goes, so a
 * validation path that reaches the database fails loudly instead of quietly
 * proving less than the test claims.
 */
const forbiddenPool = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `Validation reached the database (accessed pool.${String(property)}) — it must reject before any I/O.`,
      );
    },
  },
);

function makeService(blobs = new RecordingBlobs()) {
  return {
    service: new ResumesService(forbiddenPool as never, blobs as never, null as never),
    blobs,
  };
}

function file(overrides: Partial<{ buffer: Buffer; mimetype: string; size: number }> = {}) {
  const buffer = overrides.buffer ?? Buffer.from('Alex Nowak — Product Manager');
  return { buffer, mimetype: 'text/plain', size: buffer.length, ...overrides };
}

describe('upload validation (FR4)', () => {
  it('accepts exactly the three declared types and no others', () => {
    expect(extensionFor('text/plain')).toBe('txt');
    expect(extensionFor('application/pdf')).toBe('pdf');
    expect(
      extensionFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('docx');

    // The allow-list is the security boundary, so it is asserted as a closed
    // set rather than by spot-checking a few members: a fourth entry added
    // without a text extractor to match would fail here.
    expect([...ACCEPTED_MIME_TYPES.keys()].sort()).toEqual(
      [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
      ].sort(),
    );
    expect(ResumesService.acceptedMimeTypes().sort()).toEqual(
      [...ACCEPTED_MIME_TYPES.keys()].sort(),
    );
  });

  it.each([
    'application/msword', // legacy .doc — close enough to .docx to be assumed supported
    'image/png', // a photographed CV
    'application/octet-stream', // what a client sends when it does not know
    'text/html',
    '',
  ])('rejects "%s" with an actionable message', (mimeType) => {
    expect(() => extensionFor(mimeType)).toThrow(BadRequestException);
    expect(() => extensionFor(mimeType)).toThrow(/Upload a PDF, a \.docx, or plain text/);
  });

  it('rejects an unsupported type before writing anything to storage', async () => {
    const { service, blobs } = makeService();

    await expect(service.upload('user-1', file({ mimetype: 'image/png' }))).rejects.toThrow(
      BadRequestException,
    );
    expect(blobs.uploaded).toHaveLength(0);
  });

  it('rejects a file over 5 MB before writing anything to storage', async () => {
    const { service, blobs } = makeService();
    // The buffer stays small on purpose — `size` is what the check reads, and
    // allocating 5 MB to prove a comparison would only slow the suite down.
    const oversized = file({ size: MAX_UPLOAD_BYTES + 1 });

    await expect(service.upload('user-1', oversized)).rejects.toThrow(/the limit is 5 MB/);
    expect(blobs.uploaded).toHaveLength(0);
  });

  it('accepts a file exactly at the limit — the cap is inclusive', async () => {
    const { service } = makeService();
    // Reaches the database (and so throws through the forbidden pool) rather
    // than being turned away by the size check. Boundary asserted because
    // off-by-one here silently rejects a legitimate 5 MB CV.
    await expect(service.upload('user-1', file({ size: MAX_UPLOAD_BYTES }))).rejects.toThrow(
      /Validation reached the database/,
    );
  });

  it('rejects an empty upload rather than storing a zero-byte resume', async () => {
    const { service, blobs } = makeService();

    await expect(service.upload('user-1', file({ buffer: Buffer.alloc(0), size: 0 }))).rejects.toThrow(
      /No file was uploaded/,
    );
    // A missing `file` altogether is the same condition: multer yields
    // undefined when the multipart part is absent or misnamed.
    await expect(service.upload('user-1', undefined as never)).rejects.toThrow(
      /No file was uploaded/,
    );
    expect(blobs.uploaded).toHaveLength(0);
  });
});

// A minimal, hand-built single-page PDF ("Resume extraction fixture" in
// 24pt Helvetica) — no test anywhere in this suite previously ran a real PDF
// through pdf-parse; every other PDF fixture is random bytes or oversized
// garbage that never reaches the actual parser. That gap is exactly why a
// real crash (pdf-parse's bundled pdfjs-dist instantiating a DOMMatrix at
// module load time, unpolyfilled on this repo's pinned Node 20) went
// unnoticed until a real upload hit it.
const MINIMAL_PDF_BASE64 =
  'JVBERi0xLjQKMSAwIG9iaiA8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4gZW5kb2JqCjIgMCBvYmogPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4gZW5kb2JqCjMgMCBvYmogPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvTWVkaWFCb3ggWzAgMCAzMDAgMTQ0XSAvQ29udGVudHMgNSAwIFIgPj4gZW5kb2JqCjQgMCBvYmogPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+IGVuZG9iago1IDAgb2JqIDw8IC9MZW5ndGggNTYgPj4Kc3RyZWFtCkJUIC9GMSAyNCBUZiAyMCAxMDAgVGQgKFJlc3VtZSBleHRyYWN0aW9uIGZpeHR1cmUpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMTEgMDAwMDAgbiAKdHJhaWxlciA8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MTcKJSVFT0Y=';

describe('text extraction', () => {
  it('extracts real text from an actual PDF, not just random or oversized bytes', async () => {
    const pdf = Buffer.from(MINIMAL_PDF_BASE64, 'base64');
    const text = await extractText(pdf, 'application/pdf');
    expect(text).toContain('Resume extraction fixture');
  });

  it('reads plain text and normalizes line endings', async () => {
    const text = await extractText(Buffer.from('Line one\r\nLine two\r\n'), 'text/plain');
    // CRLF is normalized because the same resume uploaded from Windows and from
    // Linux must produce the same prompt input — the platform difference that
    // already bit the prompt fingerprint once.
    expect(text).toBe('Line one\nLine two');
  });

  it('refuses a file that yields no text instead of sending an empty prompt', async () => {
    // This is what an image-only PDF looks like from here: bytes in, nothing
    // out. Sending that to the model would produce a confidently invented
    // resume and store it as the user's own history.
    await expect(extractText(Buffer.from('   \r\n  \n '), 'text/plain')).rejects.toThrow(
      /needs OCR first/,
    );
  });
});

describe('blob key layout', () => {
  const userId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const resumeId = 'bbbbbbbb-0000-4000-8000-000000000002';

  it('is user-prefixed, which is what makes erasure a single prefix delete', () => {
    expect(BlobStorageService.keyFor(userId, resumeId, 'pdf')).toBe(`${userId}/${resumeId}.pdf`);
    // The prefix boundary is a literal "/". Account deletion deletes under
    // `${userId}/`, so the separator is load-bearing rather than cosmetic.
    expect(BlobStorageService.keyFor(userId, resumeId, 'pdf').startsWith(`${userId}/`)).toBe(true);
  });

  it('normalizes the extension so one resume cannot land under two keys', () => {
    expect(BlobStorageService.keyFor(userId, resumeId, '.PDF')).toBe(`${userId}/${resumeId}.pdf`);
    expect(BlobStorageService.keyFor(userId, resumeId, 'DOCX')).toBe(`${userId}/${resumeId}.docx`);
  });

  it('omits the dot entirely when there is no extension', () => {
    expect(BlobStorageService.keyFor(userId, resumeId, '')).toBe(`${userId}/${resumeId}`);
  });

  it('names the blob after the resume id, so the key is stable and unguessable', () => {
    // No filename, no timestamp, no counter: the user's original filename would
    // put their name in a storage key, and anything derived from time would let
    // one key be guessed from another.
    const key = BlobStorageService.keyFor(userId, resumeId, 'pdf');
    expect(key).not.toMatch(/alex|cv|resume-/i);
    expect(key.split('/')[1]).toBe(`${resumeId}.pdf`);
  });
});

describe('contact stripping against the real extraction shape', () => {
  /** What the model is asked to return, in the shape the template promises. */
  const modelOutput = {
    contacts: {
      email: 'alex@example.com',
      phone: '+48 123 456 789',
      links: ['https://linkedin.com/in/alex'],
    },
    name: 'Alex Nowak',
    headline: 'Product Manager',
    summary: 'Ten years shipping B2B products.',
    experience: [
      {
        company: 'Appspace',
        title: 'Senior PM',
        start: '2021-03',
        end: null,
        location: 'Warsaw',
        highlights: ['Cut onboarding time by half', 'Owned the reservations roadmap'],
      },
    ],
    education: [{ institution: 'MSU', qualification: 'MSc', start: '2010', end: '2015' }],
    skills: ['discovery', 'roadmapping'],
    languages: [{ language: 'English', level: 'C1' }],
  };

  it('produces contacts under the field name scrub.ts strips', () => {
    // The two sides are wired by a string constant. If either is renamed alone,
    // stripping silently becomes a no-op and PII starts travelling into prompts
    // with nothing failing — hence asserting the link rather than trusting it.
    const parsed = ResumeStructureSchema.parse(modelOutput);
    expect(CONTACTS_FIELD in parsed).toBe(true);
    expect(parsed.contacts.email).toBe('alex@example.com');
  });

  it('removes contacts and leaves the experience intact', () => {
    const parsed = ResumeStructureSchema.parse(modelOutput);
    const stripped = stripContacts(parsed) as Record<string, unknown>;

    expect(stripped[CONTACTS_FIELD]).toBeUndefined();
    const serialized = JSON.stringify(stripped);
    expect(serialized).not.toContain('alex@example.com');
    expect(serialized).not.toContain('123 456 789');
    expect(serialized).not.toContain('linkedin.com');

    // The other half of the contract, and the easier one to break: a scrub that
    // took the experience with it would leave every downstream prompt — scoring,
    // tailoring — with nothing to work from.
    expect(stripped.experience).toEqual(parsed.experience);
    expect(stripped.name).toBe('Alex Nowak');
    expect(stripped.summary).toBe('Ten years shipping B2B products.');
    expect(stripped.skills).toEqual(['discovery', 'roadmapping']);
    expect(stripped.education).toEqual(parsed.education);
    expect(stripped.languages).toEqual(parsed.languages);
  });

  it('does not mutate the structure it was given', () => {
    // The extraction row is written from the same object that gets stripped on
    // the way into a later prompt. Mutating in place would erase the contacts
    // from the user's own stored resume, which they are entitled to keep.
    const parsed = ResumeStructureSchema.parse(modelOutput);
    stripContacts(parsed);
    expect(parsed.contacts.email).toBe('alex@example.com');
  });

  it('strips contacts nested inside arrays, not only at the top level', () => {
    // stripContacts recurses, and the schema may well grow a per-role contact
    // one day. Asserted now so the recursion is not dropped as unused.
    const nested = { experience: [{ company: 'Appspace', contacts: { email: 'hr@example.com' } }] };
    expect(JSON.stringify(stripContacts(nested))).not.toContain('hr@example.com');
  });

  it('leaves an email that the model put in the wrong field — a known limit', () => {
    // Documenting real behavior, not endorsing it. Structured stripping is
    // field-based: an address the model folds into `summary` instead of
    // `contacts` survives into downstream prompts. `redactContactText` is the
    // pattern-based fallback and is not applied to structured values.
    const misplaced = ResumeStructureSchema.parse({
      ...modelOutput,
      summary: 'Reach me at alex@example.com.',
    });
    expect(JSON.stringify(stripContacts(misplaced))).toContain('alex@example.com');
  });
});
