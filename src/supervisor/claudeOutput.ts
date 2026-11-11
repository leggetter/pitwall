// How Claude Code handles a large MCP tool result, for the supervisor (W184; W186's F3). An adapter,
// as AGENTS.md asks for anything undocumented: one documented variable, one undocumented one, and a
// check of the stream that fails soft, saying so in pitwall's log, if they stop holding.
//
// What Claude Code 2.1.322 does with a large result, found with a throwaway stdio server returning
// text of a chosen size to a `claude -p` on Haiku with the supervisor's strict flags (W186 and W184's
// fix, 2026-11-11), the transcript kept as the supervisor's is:
//
// - Past `MAX_MCP_OUTPUT_TOKENS` (documented, default 25,000), by default it saves the whole result to
//   `~/.claude/projects/<folder>/<session>/tool-results/mcp-<server>-<tool>-<time>.txt`, at 0644, and
//   gives the model only its path and a short preview. 200,000 characters went to a file whole.
// - With `ENABLE_MCP_LARGE_OUTPUT_FILES=0` (undocumented), it cuts the result to `MAX_MCP_OUTPUT_TOKENS`
//   times 4 characters and adds a note of about 1,000 characters, "[OUTPUT TRUNCATED - exceeded ...]".
// - Separately, any tool result over about 50,000 characters is saved to `tool-results/<tool use id>.json`
//   with a 2 KB preview: 50,500 characters was saved, and a 49,500-character result with its note,
//   50,535 characters, wasn't. At 16,000 tokens a cut result, 64,000 characters, was saved (W186).
//
// So the supervisor runs with ENABLE_MCP_LARGE_OUTPUT_FILES=0 and 11,000 tokens: a cut result is at
// most 44,000 characters plus the note, 44,961 in the check, under that threshold with room. Pitwall's
// own answers are at most 40,000 characters, so they're never cut, though one past 11,000 tokens gets
// the note. If either variable stops holding, a result is saved to a file under `~/.claude` again:
// pitwall can't prevent that, but it reads the stream, and logs once a run when a tool result says it
// was saved (savedToolResult()).

/** The most tokens one MCP tool result may bring in: Claude Code's `MAX_MCP_OUTPUT_TOKENS`. */
export const SUPERVISOR_MCP_OUTPUT_TOKENS = 11_000;

/** The variables pitwall sets for this, so yours are left out. */
export const OUTPUT_LIMIT_VARIABLES: ReadonlySet<string> = new Set(['MAX_MCP_OUTPUT_TOKENS', 'ENABLE_MCP_LARGE_OUTPUT_FILES']);

/** What the supervisor's environment gets: the cap, and cut rather than saved. */
export function outputLimitEnvironment(): Record<string, string> {
  return { MAX_MCP_OUTPUT_TOKENS: String(SUPERVISOR_MCP_OUTPUT_TOKENS), ENABLE_MCP_LARGE_OUTPUT_FILES: '0' };
}

/** What Claude Code puts in a tool result it saved to a file instead (2.1.322). */
const SAVED_MARKERS = ['<persisted-output>', 'Full output saved to', '/tool-results/'];

/** True when a `tool_result` block's content says Claude Code saved the result to a file. */
export function savedToolResult(content: unknown): boolean {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : '')).join('\n') : '';
  // Only the start: the saved form is a short notice, and a result's own text could mention a marker.
  const head = text.slice(0, 600);
  return SAVED_MARKERS.some((marker) => head.includes(marker));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
