// Claude Code's built-in slash commands, which a work profile's skill may never name (W180's I3).
//
// A profile's skill starts the session's first prompt as `/<skill> <prompt>` (W155, profiles.ts). A
// name that is one of Claude Code's own commands runs that command instead, such as `/logout`,
// `/clear` or `/login`, so a profile can't name one. A plugin's `plugin:skill` is never one of these.
//
// From the commands reference, https://code.claude.com/docs/en/commands, "All commands", read on
// 2026-11-10 (Claude Code 2.1.321): every command and alias but the bundled skills and workflows,
// which are skills, run as a skill a profile names does (`/simplify`, `/loop`, `/code-review` and its
// alias `/review`, `/doctor` and its alias `/checkup`, `/design`, `/deep-research` and the rest).
// Compared without case. A command a later version adds isn't here until this list is updated; it
// then runs as typed, as it would from the prompt box.

/** The built-in commands' names, without their `/`. */
export const BUILT_IN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'add-dir', 'advisor', 'agents', 'artifacts', 'auto-mode-setup', 'autocompact', 'autofix-pr',
  'background', 'branch', 'btw', 'bug', 'cd', 'chrome', 'clear', 'color', 'compact', 'config',
  'context', 'copy', 'cost', 'design-login', 'desktop', 'diff', 'effort', 'exit', 'export', 'fast',
  'feedback', 'focus', 'fork', 'goal', 'heapdump', 'help', 'hooks', 'ide', 'import', 'init',
  'insights', 'install-github-app', 'install-slack-app', 'keybindings', 'list-agents', 'login',
  'logout', 'mcp', 'memory', 'mobile', 'model', 'output-style', 'passes', 'permissions', 'plan',
  'plugin', 'plugin-authoring', 'powerup', 'pr-comments', 'privacy-settings', 'radio',
  'rate-limit-options', 'recap', 'release-notes', 'reload-plugins', 'reload-skills',
  'remote-control', 'remote-env', 'rename', 'restart', 'resume', 'rewind', 'sandbox', 'schedule',
  'scroll-speed', 'security-review', 'setup-bedrock', 'setup-vertex', 'skill-doctor', 'skills',
  'stats', 'status', 'statusline', 'stickers', 'stop', 'subtask', 'tasks', 'team-onboarding',
  'teleport', 'terminal-setup', 'theme', 'tui', 'ultraplan', 'ultrareview', 'upgrade', 'usage',
  'usage-credits', 'vim', 'voice', 'web-setup', 'workflows',
]);

/** Their aliases. */
export const BUILT_IN_COMMAND_ALIASES: ReadonlySet<string> = new Set([
  'bg', 'share', 'reset', 'new', 'settings', 'app', 'quit', 'ios', 'android', 'allowed-tools',
  'rc', 'update', 'continue', 'checkpoint', 'undo', 'routines',
]);

/** True when `name`, without case, is one of Claude Code's built-in commands or their aliases. */
export function isBuiltInCommand(name: string): boolean {
  const folded = name.toLowerCase();
  return BUILT_IN_COMMAND_NAMES.has(folded) || BUILT_IN_COMMAND_ALIASES.has(folded);
}
