import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Prompt instructions live as prose in `text/*.md`, not as string arrays in
 * TypeScript. At one template the difference is cosmetic; at twenty it is the
 * difference between a readable diff of an instruction change and a diff of
 * quote marks and `.join('\n')`.
 *
 * The files ship to `dist` via the `assets` entry in nest-cli.json. A missing
 * file is therefore a packaging failure, and packaging failures must surface
 * at boot — see `assertTemplateTextAvailable`. Discovering it at the first
 * model call instead would mean a working deploy that breaks the moment a
 * user does something.
 */
const TEXT_DIR = join(__dirname, 'text');
const cache = new Map<string, string>();

export function loadTemplateText(fileName: string): string {
  const cached = cache.get(fileName);
  if (cached !== undefined) return cached;

  const path = join(TEXT_DIR, fileName);
  let text: string;
  try {
    // Line endings are normalized to LF because git rewrites them per platform
    // on checkout. Without this the same commit yields a different prompt (and
    // a different fingerprint in template-versions.spec.ts) on Windows than on
    // Linux — found by merging, after CI had passed on Linux.
    text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim();
  } catch (err) {
    throw new Error(
      `Prompt text "${fileName}" not found at ${path}. ` +
        'It must be copied into dist by the "assets" entry in nest-cli.json.',
      { cause: err },
    );
  }

  if (!text) {
    throw new Error(`Prompt text "${fileName}" is empty.`);
  }

  cache.set(fileName, text);
  return text;
}
