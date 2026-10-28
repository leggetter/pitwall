export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * C0 controls, DEL and C1 controls, and the bidi marks (U+061C, U+200E, U+200F), embeddings and
 * overrides (U+202A to U+202E) and isolates (U+2066 to U+2069): the server's one set, the same as the
 * web UI's UNSAFE rule (web/src/sessions.ts). A directory with one would read differently, in a
 * message or in a command to copy such as the trust hint, from the directory it names, so pitwall
 * never runs a command in one (checkDirectory, server/actions.ts), lists an ended session that
 * started in one (ended.ts) or lists one to pick (server/directories.ts).
 */
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** True when `text` has a character from UNSAFE_CHARACTERS. */
export function hasUnsafeCharacters(text: string): boolean {
  return UNSAFE_CHARACTERS.test(text);
}
