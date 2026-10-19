// The names `claude` treats as a subcommand rather than a prompt.
//
// Spawn runs `claude --bg [--name n] [--model m] -- <prompt>` (actions.ts).
// `--` stops option parsing, but the commander bundled with Claude Code still
// dispatches when the first operand exactly names a command, so a prompt of
// just `update` or `purge` could run `claude update` or `claude purge` in
// the session's directory instead of starting a session. Spawn refuses a
// prompt that, trimmed and lower-cased, is one of these names. Commander
// matches names exactly and is case-sensitive, so trimming and lower-casing
// refuses more than it strictly needs to, never less.
//
// Never check this by running one of them: `claude update` and `claude
// logout` change the machine. claudeCommands.test.ts compares this list with
// `claude --help`, which only prints.

/**
 * Every subcommand name and alias, from Claude Code 2.1.303 on 2026-10-19:
 * - listed by `claude --help`;
 * - hidden from it, but registered in that version's bundle (found by reading
 *   its strings, nothing run): commander dispatches to hidden commands too;
 * - names 2.1.303 doesn't have at the top level, kept in case another
 *   version does: `config`, `login` and `logout` (it has `auth login` and
 *   `auth logout`), and `help`, which commander adds to some programs.
 */
export const CLAUDE_COMMANDS: ReadonlySet<string> = new Set([
  // In `claude --help`.
  'agents',
  'attach',
  'auth',
  'auto-mode',
  'doctor',
  'gateway',
  'import',
  'install',
  'kill',
  'logs',
  'mcp',
  'plugin',
  'plugins',
  'purge',
  'respawn',
  'rm',
  'setup-token',
  'stop',
  'ultrareview',
  'update',
  'upgrade',
  // Hidden in 2.1.303.
  'design-login',
  'drop-worktree-registrations',
  'edit-chrome-settings',
  'edit-hook',
  'edit-memory-settings',
  'edit-permission-rules',
  'edit-sandbox-settings',
  'edit-skill-overrides',
  'import-conversations',
  'project',
  'rc',
  'remote-control',
  'sandbox',
  // Not top-level in 2.1.303.
  'config',
  'help',
  'login',
  'logout',
]);

/** True when `prompt`, trimmed and lower-cased, is a `claude` subcommand or alias. */
export function isClaudeCommand(prompt: string): boolean {
  return CLAUDE_COMMANDS.has(prompt.trim().toLowerCase());
}

/**
 * The command names and aliases in the `Commands:` section of `claude
 * --help`: the first word of each entry, split at `|`, as in `stop|kill <id>`.
 * Entries start two spaces in; their wrapped descriptions start further in.
 */
export function helpCommands(help: string): string[] {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => /^Commands:\s*$/.test(line));
  if (start === -1) return [];
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // The next section, such as `Options:`, ends this one.
    if (/^\S/.test(line)) break;
    const entry = /^ {2}([a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)*)(?:\s|$)/.exec(line);
    if (entry) names.push(...(entry[1] as string).split('|'));
  }
  return names;
}
