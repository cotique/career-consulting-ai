/**
 * Launch is capped to Europe (T13). The cap is enforced here in application
 * code rather than as a DB constraint, so widening the market list later is a
 * code change and not a migration.
 *
 * ISO 3166-1 alpha-2, geographic Europe (EU/EEA plus the non-member European
 * states) — not the EU membership list, since job markets don't follow it.
 */
export const EUROPEAN_COUNTRY_CODES = new Set([
  'AL', 'AD', 'AT', 'BA', 'BE', 'BG', 'BY', 'CH', 'CY', 'CZ', 'DE', 'DK',
  'EE', 'ES', 'FI', 'FO', 'FR', 'GB', 'GE', 'GI', 'GR', 'HR', 'HU', 'IE',
  'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MT', 'NL',
  'NO', 'PL', 'PT', 'RO', 'RS', 'SE', 'SI', 'SK', 'SM', 'UA', 'VA', 'XK',
]);

export function isEuropeanCountryCode(code: string): boolean {
  return EUROPEAN_COUNTRY_CODES.has(code.toUpperCase());
}

/** IANA zone names, validated against the runtime's own tz database. */
export function isValidTimezone(tz: string): boolean {
  try {
    // Throws RangeError for an unknown zone — cheaper and always current
    // compared to shipping our own list.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 24-hour HH:MM. */
export function isValidTimeOfDay(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/**
 * ISO 639-1, two letters. Validated on the way in because this value is later
 * interpolated into the *trusted* half of a prompt (the LLM layer's `language`
 * parameter) — a stored free-text "language" would either be rejected there at
 * request time or, worse, become a way to write into instructions.
 */
export function isValidUiLanguage(value: string): boolean {
  return /^[a-z]{2}$/.test(value);
}
