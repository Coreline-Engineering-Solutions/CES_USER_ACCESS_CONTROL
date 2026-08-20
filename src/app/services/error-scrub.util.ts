/**
 * Backend error/warning text sometimes embeds a raw UUID — meaningless to a
 * user reading a toast or banner, and actively confusing ("what is that
 * string?"). Strips any canonical UUID token from a message and tidies up
 * the resulting whitespace.
 *
 * Deliberately narrow: only matches the full 36-char dashed UUID form, so it
 * never touches legitimate short references the UI shows on purpose.
 */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function scrubTechnicalIds(text: string): string {
  if (!text) return text;
  return text
    .replace(UUID_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}
