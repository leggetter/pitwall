// What Claude Code would use where pitwall passes no `--model` or `--effort` (W122): read, never
// written, from the settings files and environment variables Claude Code documents, so Preferences
// and New session can say "Default: Opus 5.5 (your Claude Code settings)" in place of "Claude Code's
// default". Claude Code documents no command that prints the effective model or effort without
// starting a conversation (`claude doctor` checks settings files, `/status` is in a session), and
// pitwall never makes a model call to find out. So it follows the documented order itself, and says
// what it can't see: an organization's default or policy from claude.ai, an MDM profile, or your plan.
//
// What it follows (code.claude.com/docs, read for W122 on 2026-11-02):
//
// - Files (settings, "Settings precedence"; managed-settings): managed, then the project's
//   `.claude/settings.local.json`, its `.claude/settings.json`, then `~/.claude/settings.json`
//   (`$CLAUDE_CONFIG_DIR/settings.json` when set). The first that sets a key decides it. The managed
//   file is `managed-settings.json` then `managed-settings.d/*.json` in name order, merged, in
//   /Library/Application Support/ClaudeCode on macOS, /etc/claude-code on Linux, C:\Program
//   Files\ClaudeCode on Windows. The local file is at the git repository's root, the main checkout's
//   for a worktree, and also read, below it, from the directory itself (settings, "Where Claude Code
//   keeps the local file"). The shared file is read from the directory.
// - A settings file's `env` overwrites a variable from the shell, the highest file's winning
//   (settings-reference, `env`). An empty value counts as unset.
// - Model (model-config, "Setting your model"; settings-reference, `model`): ANTHROPIC_MODEL, then
//   `model`, then an organization's default, which pitwall can't see, then ANTHROPIC_DEFAULT_MODEL,
//   unless it's default, inherit, opusplan or haiku, then your account's default.
// - Effort (model-config, "Adjust effort level"; settings-reference, `effortLevel`, `modelSettings`,
//   `maxEffortLevel`; env-vars): CLAUDE_CODE_EFFORT_LEVEL, `auto` or `unset` for none sent; then
//   per model, the highest file setting `modelSettings.<model>.effortLevel`, or a top-level
//   `effortLevel` that applies to it, the model's entry first within a file (a user file's top-level
//   one no longer applies from Opus 5.5 on); then the model's own: `medium` on Opus, Sonnet and Haiku
//   5.5, `xhigh` on Opus 4.7, `high` on the others that take effort. The lowest `maxEffortLevel`
//   caps it.
// - Aliases (model-config, "Model aliases"): on the Anthropic API, opus, sonnet and haiku are the 5.5
//   models and fable Fable 5.1, unless ANTHROPIC_DEFAULT_<ALIAS>_MODEL pins one. On another provider
//   (CLAUDE_CODE_USE_BEDROCK and the like) they're left unresolved.
// - What each kind loads: a session (`claude --bg`) every file and its environment, as `claude` in
//   that directory (agent-view); the supervisor, recaps and the relay (`claude -p --setting-sources
//   ""`) the managed settings alone, since `--setting-sources` lists only user, project and local.
//   Recaps and the supervisor drop CLAUDE_CODE_EFFORT_LEVEL from their environment
//   (src/recaps/prompt.ts, src/supervisor/prompt.ts); the relay keeps it.
//
// Fails soft: a file that's missing, over 1 MiB, not a regular file (a FIFO isn't waited on),
// unreadable or not a JSON object is skipped, as `claude -p` skips a broken one, and a value of the
// wrong type is ignored. Each is read as the config file is (D24): open, fstat, a capped read. A model
// that isn't one pitwall allows is never sent, only its source (checkedModel()).
//
// Two gaps the docs leave: whether `--setting-sources ""` still loads managed settings (it lists only
// user, project and local, so pitwall assumes yes), and where the local file lives when the repository
// root isn't yours (Claude Code then keeps it with `.claude/settings.json`; pitwall doesn't check the
// owner, so it reads the root's).
import { closeSync, constants, fstatSync, openSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EFFORT_LEVELS,
  isWorkModel,
  OFFERED_WORK_MODELS,
  WORK_DEFAULT,
  WORK_KINDS,
  type ClaudeDefault,
  type ClaudeDefaults,
  type ClaudeSettingsScope,
  type EffortLevel,
  type WorkChoices,
  type WorkKind,
} from '../shared/protocol.js';
import { readCapped } from '../config.js';
import { matchRoot } from '../index/roots.js';

/** A settings file, read: what W122 uses of it. */
export interface ClaudeSettingsFile {
  scope: ClaudeSettingsScope;
  model?: string;
  effortLevel?: string;
  maxEffortLevel?: string;
  /** By model name: its effortLevel and maxEffortLevel. */
  modelSettings?: Record<string, { effortLevel?: string; maxEffortLevel?: string }>;
  env?: Record<string, string>;
}

/** The files a process loads, highest precedence first, and the environment it starts with. */
export interface ClaudeSources {
  files: readonly ClaudeSettingsFile[];
  env: Readonly<Record<string, string | undefined>>;
}

/** The most a settings file may hold, as the config file (D24). */
export const MAX_SETTINGS_BYTES = 1024 * 1024;

/** The most a worktree's `.git` file may hold: one `gitdir:` line. */
export const MAX_GIT_FILE_BYTES = 4 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A parsed settings document, reduced to W122's keys. Undefined when it isn't an object. */
export function readSettingsDocument(scope: ClaudeSettingsScope, value: unknown): ClaudeSettingsFile | undefined {
  if (!isRecord(value)) return undefined;
  const file: ClaudeSettingsFile = { scope };
  const model = str(value.model);
  if (model !== undefined) file.model = model;
  const effort = str(value.effortLevel);
  if (effort !== undefined) file.effortLevel = effort;
  const max = str(value.maxEffortLevel);
  if (max !== undefined) file.maxEffortLevel = max;
  if (isRecord(value.modelSettings)) {
    const entries: NonNullable<ClaudeSettingsFile['modelSettings']> = {};
    for (const [name, entry] of Object.entries(value.modelSettings)) {
      if (!isRecord(entry)) continue;
      const level = str(entry.effortLevel);
      const cap = str(entry.maxEffortLevel);
      if (level === undefined && cap === undefined) continue;
      entries[name] = { ...(level === undefined ? {} : { effortLevel: level }), ...(cap === undefined ? {} : { maxEffortLevel: cap }) };
    }
    file.modelSettings = entries;
  }
  if (isRecord(value.env)) {
    const env: Record<string, string> = {};
    for (const [name, v] of Object.entries(value.env)) if (typeof v === 'string') env[name] = v;
    file.env = env;
  }
  return file;
}

/** Later over earlier, key by key, `modelSettings` and `env` merged a level down, as managed drop-ins merge. */
function mergeSettings(scope: ClaudeSettingsScope, docs: readonly ClaudeSettingsFile[]): ClaudeSettingsFile | undefined {
  if (docs.length === 0) return undefined;
  const merged: ClaudeSettingsFile = { scope };
  for (const doc of docs) {
    if (doc.model !== undefined) merged.model = doc.model;
    if (doc.effortLevel !== undefined) merged.effortLevel = doc.effortLevel;
    if (doc.maxEffortLevel !== undefined) merged.maxEffortLevel = doc.maxEffortLevel;
    if (doc.modelSettings !== undefined) {
      merged.modelSettings ??= {};
      for (const [name, entry] of Object.entries(doc.modelSettings)) merged.modelSettings[name] = { ...merged.modelSettings[name], ...entry };
    }
    if (doc.env !== undefined) merged.env = { ...merged.env, ...doc.env };
  }
  return merged;
}

/**
 * A regular file's bytes, or undefined: as the config file is read (D24, src/config.ts), opened with
 * O_NONBLOCK so a FIFO isn't waited on, checked through the open file (fstat), never stat-then-open,
 * and read up to `max` bytes, stopping there. A symbolic link is followed; what it leads to must be a
 * regular file.
 */
export function readBounded(file: string, max: number): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    return undefined;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > max) return undefined;
    return readCapped(fd, max);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function readJson(file: string): unknown {
  const bytes = readBounded(file, MAX_SETTINGS_BYTES);
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function readSettingsFile(scope: ClaudeSettingsScope, file: string): Promise<ClaudeSettingsFile | undefined> {
  return readSettingsDocument(scope, readJson(file));
}

/** The system directory of file-based managed settings (managed-settings, "Where each mechanism stores the policy"). */
export function managedSettingsDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

/** `managed-settings.json`, then `managed-settings.d/*.json` by name, hidden files left out, merged. */
export async function readManagedSettings(dir: string): Promise<ClaudeSettingsFile | undefined> {
  const docs: ClaudeSettingsFile[] = [];
  const base = await readSettingsFile('managed', path.join(dir, 'managed-settings.json'));
  if (base) docs.push(base);
  let names: string[] = [];
  try {
    names = (await readdir(path.join(dir, 'managed-settings.d'))).filter((name) => name.endsWith('.json') && !name.startsWith('.')).sort();
  } catch {
    // No drop-in directory.
  }
  for (const name of names) {
    const doc = await readSettingsFile('managed', path.join(dir, 'managed-settings.d', name));
    if (doc) docs.push(doc);
  }
  return mergeSettings('managed', docs);
}

function realOrSame(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Where the local settings file lives for `dir`: the git repository's root, or for a linked
 * worktree, the main checkout's root. `dir` itself outside a repository, or where the root is your
 * home directory (settings, "Where Claude Code keeps the local file").
 *
 * A `.git` file's `gitdir:` is the directory's own say (W122's review): its main checkout is used
 * only when it's under one of `roots`, or `dir` is inside it, as a worktree in `.worktrees/` is;
 * else the worktree's own root. The file is read as the settings files are, at most 4 KiB.
 */
export async function localSettingsRoot(dir: string, home: string, roots: readonly string[] = []): Promise<string> {
  let current = dir;
  for (;;) {
    const marker = path.join(current, '.git');
    let found: 'dir' | 'file' | undefined;
    let fd: number | undefined;
    try {
      fd = openSync(marker, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      const stats = fstatSync(fd);
      found = stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : undefined;
    } catch {
      // Not here: up a level.
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (found !== undefined) {
      let root = current;
      if (found === 'file') {
        // A linked worktree: "gitdir: <main>/.git/worktrees/<name>".
        const text = readBounded(marker, MAX_GIT_FILE_BYTES)?.toString('utf8');
        const match = text === undefined ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);
        const gitdir = match?.[1] === undefined ? undefined : path.resolve(current, match[1]);
        const worktrees = gitdir === undefined ? undefined : path.dirname(gitdir);
        if (worktrees !== undefined && path.basename(worktrees) === 'worktrees' && path.basename(path.dirname(worktrees)) === '.git') {
          const main = path.dirname(path.dirname(worktrees));
          const realMain = realOrSame(main);
          const realRoots = roots.map(realOrSame);
          const inside = path.relative(realMain, realOrSame(dir));
          const ownRepo = inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside));
          if (ownRepo || matchRoot(realMain, realRoots) !== undefined) root = main;
        }
      }
      return root === home ? dir : root;
    }
    const parent = path.dirname(current);
    if (parent === current) return dir;
    current = parent;
  }
}

export interface ClaudeSettingsPaths {
  /** `~/.claude`, or CLAUDE_CONFIG_DIR. */
  configDir: string;
  /** Where managed-settings.json lives. */
  managedDir: string;
  home: string;
  /** The roots, for which main checkouts a worktree's `.git` file may lead to. */
  roots?: readonly string[];
}

/** The documented places, for this machine and environment. */
export function claudeSettingsPaths(env: Readonly<Record<string, string | undefined>> = process.env): ClaudeSettingsPaths {
  const home = os.homedir();
  const configured = env.CLAUDE_CONFIG_DIR;
  return { configDir: configured !== undefined && configured !== '' && path.isAbsolute(configured) ? configured : path.join(home, '.claude'), managedDir: managedSettingsDir(), home };
}

/** What a session started in `dir` would load, and what the `-p` kinds load: managed alone. */
export interface ClaudeSettingsRead {
  session: ClaudeSettingsFile[];
  managed: ClaudeSettingsFile[];
}

/** Reads the files, highest precedence first. With no `dir`, sessions get your user settings alone. */
export async function readClaudeSettings(paths: ClaudeSettingsPaths, dir?: string): Promise<ClaudeSettingsRead> {
  const managed = await readManagedSettings(paths.managedDir);
  const project: ClaudeSettingsFile[] = [];
  if (dir !== undefined) {
    const root = await localSettingsRoot(dir, paths.home, paths.roots ?? []);
    const atRoot = await readSettingsFile('local', path.join(root, '.claude', 'settings.local.json'));
    // A local file an earlier Claude Code left in the directory itself still counts, below the root's.
    const atDir = root === dir ? undefined : await readSettingsFile('local', path.join(dir, '.claude', 'settings.local.json'));
    const local = mergeSettings('local', [atDir, atRoot].filter((file): file is ClaudeSettingsFile => file !== undefined));
    if (local) project.push(local);
    const shared = await readSettingsFile('project', path.join(dir, '.claude', 'settings.json'));
    if (shared) project.push(shared);
  }
  // CLAUDE_CONFIG_DIR may come from a managed file's env too; your own env can't move it from user settings' own.
  const configDir = (() => {
    const fromManaged = managed?.env?.CLAUDE_CONFIG_DIR;
    return fromManaged !== undefined && fromManaged !== '' && path.isAbsolute(fromManaged) ? fromManaged : paths.configDir;
  })();
  const user = await readSettingsFile('user', path.join(configDir, 'settings.json'));
  const managedList = managed ? [managed] : [];
  return { session: [...managedList, ...project, ...(user ? [user] : [])], managed: managedList };
}

/** A variable as the process would see it: the highest settings file's `env`, else the environment. Empty is unset. */
export function variable(sources: ClaudeSources, name: string): { value: string; scope?: ClaudeSettingsScope } | undefined {
  for (const file of sources.files) {
    const value = file.env?.[name];
    if (value !== undefined) return value === '' ? undefined : { value, scope: file.scope };
  }
  const value = sources.env[name];
  return value === undefined || value === '' ? undefined : { value };
}

function variableDefault(name: string, found: { value: string; scope?: ClaudeSettingsScope }): ClaudeDefault {
  return { value: found.value, source: { kind: 'variable', name, ...(found.scope === undefined ? {} : { scope: found.scope }) } };
}

/**
 * A model default, sent only when it's one isWorkModel() allows for `kind`; otherwise its source,
 * noted `unrecognised` (W122's review): a project's settings file comes with a clone, and could hold
 * text dressed as advice, such as a command to run.
 */
export function checkedModel(found: ClaudeDefault, kind: WorkKind = 'session'): ClaudeDefault {
  if (found.value === undefined || isWorkModel(found.value, kind)) return found;
  return { source: found.source, note: 'unrecognised' };
}

/** The model a process started with no `--model` runs on, or `account` when only Claude Code can know. */
export function resolveModel(sources: ClaudeSources): ClaudeDefault {
  const env = variable(sources, 'ANTHROPIC_MODEL');
  if (env !== undefined && env.value !== WORK_DEFAULT) return checkedModel(variableDefault('ANTHROPIC_MODEL', env));
  for (const file of sources.files) {
    if (file.model !== undefined && file.model !== '' && file.model !== WORK_DEFAULT) return checkedModel({ value: file.model, source: { kind: 'setting', key: 'model', scope: file.scope } });
  }
  // An organization's default would come here; pitwall can't see it, so the next is only a likely answer
  // where there's none. ANTHROPIC_DEFAULT_MODEL's own exceptions (model-config):
  const fallback = variable(sources, 'ANTHROPIC_DEFAULT_MODEL');
  if (fallback !== undefined && !['default', 'inherit', 'opusplan', 'haiku'].includes(fallback.value)) return checkedModel(variableDefault('ANTHROPIC_DEFAULT_MODEL', fallback));
  return { source: { kind: 'account' } };
}

/** The providers whose aliases resolve to other models (env-vars; model-config, "Model aliases"). */
const PROVIDER_VARIABLES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE'];

/** On the Anthropic API (model-config, "Model aliases"). */
const ALIAS_MODELS: Readonly<Record<string, string>> = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' };

/**
 * The full name an alias stands for, by ANTHROPIC_DEFAULT_<ALIAS>_MODEL or the Anthropic API's
 * table; a full name as itself, without a date or `[1m]`. Undefined where it depends on what pitwall
 * can't see: `best`, `opusplan`, or an alias on another provider.
 */
export function canonicalModel(model: string, sources: ClaudeSources): string | undefined {
  const bare = model.replace(/\[1m\]$/i, '').toLowerCase();
  const alias = ALIAS_MODELS[bare];
  if (alias !== undefined) {
    const pinned = variable(sources, `ANTHROPIC_DEFAULT_${bare.toUpperCase()}_MODEL`);
    if (pinned !== undefined) return canonicalModel(pinned.value, { ...sources, files: [], env: {} });
    if (PROVIDER_VARIABLES.some((name) => { const v = variable(sources, name); return v !== undefined && v.value !== '0'; })) return undefined;
    return alias;
  }
  const full = /^(claude-(?:opus|sonnet|haiku|fable)(?:-\d{1,2}){1,2})(?:-\d{8})?$/.exec(bare);
  return full?.[1];
}

/** A full name's family and version, as `claude-opus-5-5` gives opus, 5.5. */
function parseModel(canonical: string): { family: string; version: number } | undefined {
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?$/.exec(canonical);
  if (!match) return undefined;
  return { family: match[1]!, version: Number(`${match[2]}.${match[3] ?? '0'}`) };
}

/** Models that take effort (model-config, "Adjust effort level"), by family and version. */
const EFFORT_MODELS: Readonly<Record<string, readonly number[]>> = {
  fable: [5, 5.1],
  opus: [4.6, 4.7, 4.8, 5, 5.5],
  sonnet: [4.6, 5, 5.5],
  haiku: [5.5],
};

/**
 * The model's own effort: `medium` on Opus, Sonnet and Haiku 5.5, `xhigh` on Opus 4.7, `high` on the
 * others that take effort, none on one that doesn't. Undefined for a model the docs don't list.
 */
export function modelEffort(canonical: string): { value?: EffortLevel } | undefined {
  const parsed = parseModel(canonical);
  if (!parsed) return undefined;
  const versions = EFFORT_MODELS[parsed.family] ?? [];
  if (!versions.includes(parsed.version)) {
    // Older than the list: no effort levels. Newer: not documented when read, so unknown.
    const newest = Math.max(...versions, 0);
    return parsed.version > newest ? undefined : {};
  }
  if (parsed.version === 5.5 && parsed.family !== 'fable') return { value: 'medium' };
  if (parsed.family === 'opus' && parsed.version === 4.7) return { value: 'xhigh' };
  return { value: 'high' };
}

/**
 * Whether a user file's top-level `effortLevel` applies, as far as the docs say (settings-reference,
 * `effortLevel`): it keeps applying "on Opus 5, Fable 5.1, and earlier models", and Opus 5.5 and
 * later ignore it. For Sonnet and Haiku the docs don't say: undefined, "may not apply".
 */
function userEffortApplies(canonical: string): boolean | undefined {
  const parsed = parseModel(canonical);
  if (parsed === undefined) return undefined;
  if (parsed.family === 'opus') return parsed.version < 5.5;
  if (parsed.family === 'fable') return parsed.version <= 5.1 ? true : undefined;
  return undefined;
}

/** The entry for `canonical` in a file's `modelSettings`: its name, an alias of it, or with a date or `[1m]`. */
function modelEntry(file: ClaudeSettingsFile, canonical: string, sources: ClaudeSources): { effortLevel?: string; maxEffortLevel?: string } | undefined {
  if (file.modelSettings === undefined) return undefined;
  for (const [name, entry] of Object.entries(file.modelSettings)) if (canonicalModel(name, sources) === canonical) return entry;
  return undefined;
}

const SETTING_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh'];
const rank = (level: string) => (EFFORT_LEVELS as readonly string[]).indexOf(level);

/**
 * The effort a process started with no `--effort` runs at, on `model` (an alias or full name, or
 * undefined when the model itself can't be known). `effortVariable` is false for the kinds that drop
 * CLAUDE_CODE_EFFORT_LEVEL from their environment; a settings file's `env` still sets it for them.
 */
export function resolveEffort(model: string | undefined, sources: ClaudeSources, effortVariable = true): ClaudeDefault {
  const env = effortVariable ? variable(sources, 'CLAUDE_CODE_EFFORT_LEVEL') : variable({ files: sources.files, env: {} }, 'CLAUDE_CODE_EFFORT_LEVEL');
  const canonical = model === undefined ? undefined : canonicalModel(model, sources);
  let result: ClaudeDefault | undefined;
  if (env !== undefined) {
    const level = env.value.toLowerCase();
    if (level === 'auto' || level === 'unset') return variableDefault('CLAUDE_CODE_EFFORT_LEVEL', { ...env, value: 'auto' });
    if (rank(level) >= 0) result = variableDefault('CLAUDE_CODE_EFFORT_LEVEL', { ...env, value: level });
  }
  if (result === undefined) {
    for (const file of sources.files) {
      // With the model unknown, a file that saves a level for any model might save one for it.
      if (canonical === undefined && Object.values(file.modelSettings ?? {}).some((entry) => entry.effortLevel !== undefined)) return { source: { kind: 'model' } };
      const entry = canonical === undefined ? undefined : modelEntry(file, canonical, sources);
      if (entry?.effortLevel !== undefined && SETTING_LEVELS.includes(entry.effortLevel)) {
        result = { value: entry.effortLevel, source: { kind: 'setting', key: 'modelSettings', scope: file.scope } };
        break;
      }
      if (file.effortLevel !== undefined && SETTING_LEVELS.includes(file.effortLevel)) {
        if (canonical === undefined && file.scope === 'user') return { source: { kind: 'model' } };
        const applies = file.scope !== 'user' ? true : userEffortApplies(canonical!);
        if (applies !== false) {
          result = { value: file.effortLevel, source: { kind: 'setting', key: 'effortLevel', scope: file.scope }, ...(applies === undefined ? { note: 'may-not-apply' as const } : {}) };
          break;
        }
      }
    }
  }
  if (result === undefined) {
    const own = canonical === undefined ? undefined : modelEffort(canonical);
    if (own === undefined) return { source: { kind: 'model' } };
    if (own.value === undefined) return { source: { kind: 'model' }, value: 'none' };
    result = { value: own.value, source: { kind: 'model' } };
  }
  // The lowest cap from any file applies; a model's own cap replaces the file's for it.
  let cap: { level: string; scope: ClaudeSettingsScope } | undefined;
  for (const file of sources.files) {
    const entry = canonical === undefined ? undefined : modelEntry(file, canonical, sources);
    const level = entry?.maxEffortLevel ?? file.maxEffortLevel;
    if (level === undefined || rank(level) < 0 || level === 'max') continue;
    if (cap === undefined || rank(level) < rank(cap.level)) cap = { level, scope: file.scope };
  }
  if (cap !== undefined && result.value !== undefined && rank(result.value) > rank(cap.level)) {
    return { value: cap.level, source: { kind: 'setting', key: 'maxEffortLevel', scope: cap.scope } };
  }
  return result;
}

/** Whether each kind drops CLAUDE_CODE_EFFORT_LEVEL from the environment pitwall gives it. */
const KEEPS_EFFORT_VARIABLE: Readonly<Record<WorkKind, boolean>> = { session: true, subagents: true, supervisor: false, recaps: false, relay: true };

/**
 * Claude Code's defaults for each kind, given what was read and pitwall's layers (for the models each
 * kind may run on, whose effort is worked out for each).
 */
export function claudeDefaults(read: ClaudeSettingsRead, env: Readonly<Record<string, string | undefined>>, layers: { builtIn: WorkChoices; config: WorkChoices; overrides: WorkChoices }, dir?: string): ClaudeDefaults {
  const model = {} as ClaudeDefaults['model'];
  const effort = {} as ClaudeDefaults['effort'];
  for (const kind of WORK_KINDS) {
    const sources: ClaudeSources = { files: kind === 'session' || kind === 'subagents' ? read.session : read.managed, env };
    if (kind === 'subagents') {
      const sub = variable(sources, 'CLAUDE_CODE_SUBAGENT_MODEL');
      model[kind] = sub === undefined ? { source: { kind: 'session' } } : checkedModel(variableDefault('CLAUDE_CODE_SUBAGENT_MODEL', sub), 'subagents');
      effort[kind] = {};
      continue;
    }
    model[kind] = resolveModel(sources);
    const candidates = new Set<string>([WORK_DEFAULT, ...OFFERED_WORK_MODELS]);
    for (const layer of [layers.overrides, layers.config, layers.builtIn]) {
      const named = layer[kind].model;
      if (named !== undefined) candidates.add(named);
    }
    effort[kind] = {};
    for (const candidate of candidates) {
      const runsOn = candidate === WORK_DEFAULT ? model[kind].value : candidate;
      const resolved = resolveEffort(runsOn, sources, KEEPS_EFFORT_VARIABLE[kind]);
      // On your account's model, whatever pitwall can't know of the model, it can't know of its effort.
      const onAccount = candidate === WORK_DEFAULT && model[kind].source.kind === 'account' && resolved.value === undefined && resolved.source.kind === 'model';
      effort[kind][candidate] = onAccount ? { source: { kind: 'account' } } : resolved;
    }
  }
  return { model, effort, ...(dir === undefined ? {} : { dir }) };
}

/** Reads Claude Code's defaults for `/api/work`: given the layers, and New session's directory, once checked. */
export type ClaudeDefaultsReader = (layers: { builtIn: WorkChoices; config: WorkChoices; overrides: WorkChoices }, dir?: string) => Promise<ClaudeDefaults | undefined>;

/** The reader for this machine: the documented files, and pitwall's environment, read at each call. */
export function createClaudeDefaultsReader(
  options: { env?: () => Readonly<Record<string, string | undefined>>; paths?: () => ClaudeSettingsPaths; roots?: () => readonly string[] } = {},
): ClaudeDefaultsReader {
  const env = options.env ?? (() => process.env);
  return async (layers, dir) => {
    try {
      const current = env();
      const paths = options.paths?.() ?? claudeSettingsPaths(current);
      const read = await readClaudeSettings({ ...paths, roots: paths.roots ?? options.roots?.() ?? [] }, dir);
      return claudeDefaults(read, current, layers, dir);
    } catch {
      return undefined;
    }
  };
}
