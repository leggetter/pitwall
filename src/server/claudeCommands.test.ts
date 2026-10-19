// The list of claude subcommands spawn refuses as a whole prompt. Nothing
// here runs a subcommand: the one live check runs `claude --help`, which only
// prints, and is skipped where claude isn't installed, as on CI.
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { CLAUDE_COMMANDS, helpCommands, isClaudeCommand } from './claudeCommands.js';
import { childEnvironment } from './command.js';

/** A made-up `claude --help`, shaped like 2.1.303's: entries two spaces in, descriptions wrapped further in. */
const HELP = `Usage: claude [options] [command] [prompt]

Arguments:
  prompt                                Your prompt

Options:
  --bg, --background                    Start the session in the background and
                                        return immediately.
  -h, --help                            Display help for command

Commands:
  agents [options]                      Manage background agents
  attach <id|name>                      Open a background session in this
                                        terminal. Part of the session name works
                                        too
  plugin|plugins                        Manage Claude Code plugins
  stop|kill <id>                        Stop a background session
  update|upgrade                        Check for updates and install if
                                        available
`;

describe('isClaudeCommand', () => {
  it('includes at least the commands and aliases the review named', () => {
    const named = ['agents', 'attach', 'auth', 'config', 'doctor', 'install', 'login', 'logout', 'logs', 'mcp', 'plugin', 'plugins', 'rm', 'setup-token', 'stop', 'kill', 'update', 'upgrade'];
    for (const name of named) expect(CLAUDE_COMMANDS.has(name), name).toBe(true);
  });

  it('matches a whole prompt that is a command, trimmed and in any case', () => {
    for (const prompt of ['logout', 'update', ' update ', 'Update', 'UPGRADE', '\tpurge\n', 'rc', 'plugins']) {
      expect(isClaudeCommand(prompt), JSON.stringify(prompt)).toBe(true);
    }
  });

  it('leaves a prompt alone that only starts or ends with a command, or is close to one', () => {
    for (const prompt of ['update the README', 'please logout', 'agents?', 'logs.', 'stop-gap', 'rm -rf', 'reply with: update', '']) {
      expect(isClaudeCommand(prompt), JSON.stringify(prompt)).toBe(false);
    }
  });
});

describe('helpCommands', () => {
  it('reads each entry of the Commands section, with its aliases, and nothing from wrapped descriptions or other sections', () => {
    expect(helpCommands(HELP)).toEqual(['agents', 'attach', 'plugin', 'plugins', 'stop', 'kill', 'update', 'upgrade']);
  });

  it('finds nothing without a Commands section', () => {
    expect(helpCommands('Usage: claude [options]\n\nOptions:\n  -h, --help  Display help\n')).toEqual([]);
  });
});

// `claude --help` only prints. Run from the temp directory, with the same
// scrubbed environment pitwall gives its children.
const help = spawnSync('claude', ['--help'], { cwd: tmpdir(), env: childEnvironment(process.env), encoding: 'utf8', timeout: 15_000 });
const installed = help.error === undefined && help.status === 0;

describe.skipIf(!installed)('the installed claude', () => {
  it('lists no command that CLAUDE_COMMANDS lacks', () => {
    const listed = helpCommands(help.stdout);
    // A parse that found nothing would pass vacuously.
    expect(listed.length).toBeGreaterThan(5);
    expect(listed.filter((name) => !CLAUDE_COMMANDS.has(name))).toEqual([]);
  });
});
