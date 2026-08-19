import type { TaskType } from '../types';

/**
 * Trusted prompt parameters (retro-audit 3.9). These are *not* free text —
 * they are validated codes, so interpolating them into trusted instructions
 * can't become an injection channel. Anything a person typed goes through
 * `untrusted` instead.
 *
 * `language` is the conversation/output language (ISO 639-1, from the user's
 * `ui_language`). `market` is the target market (ISO 3166-1 alpha-2).
 * Deliverable language is deliberately not a profile setting — it's derived
 * per-vacancy by the caller (T9 note).
 */
export interface TemplateParams {
  language?: string;
  market?: string;
}

export interface PromptTemplate {
  /** Registry key. Stable — it appears in usage logs via `version`. */
  readonly name: string;
  /**
   * The prompt version, pinned here rather than passed by callers
   * (retro-audit 3.4). Bump it whenever `build` changes in a way that could
   * move outputs, or self-audit will compare across a silent revision.
   */
  readonly version: string;
  readonly taskType: TaskType;
  /** File under `templates/text/` holding this template's instruction prose. */
  readonly textFile: string;
  /**
   * Labels of the untrusted inputs this template expects. Supplying a label
   * that isn't listed — or omitting one that is — is a programming error and
   * fails before any spend.
   */
  readonly untrusted: readonly string[];
  readonly maxTokens: number;
  /** Builds the trusted instructions (the system prompt). */
  build(params: TemplateParams): string;
}

const LANGUAGE_CODE = /^[a-z]{2}$/;
const MARKET_CODE = /^[A-Z]{2}$/;

export function assertValidParams(params: TemplateParams): void {
  if (params.language !== undefined && !LANGUAGE_CODE.test(params.language)) {
    throw new Error(`language must be a two-letter ISO 639-1 code, got "${params.language}".`);
  }
  if (params.market !== undefined && !MARKET_CODE.test(params.market)) {
    throw new Error(`market must be a two-letter ISO 3166-1 alpha-2 code, got "${params.market}".`);
  }
}

/** Standard trailing lines so every template states language/market the same way. */
export function renderParams(params: TemplateParams): string {
  const lines: string[] = [];
  if (params.language) lines.push(`Write your entire response in language "${params.language}".`);
  if (params.market) lines.push(`The target job market is country "${params.market}".`);
  return lines.length ? `\n\n${lines.join('\n')}` : '';
}
