// W122: Claude Code's defaults where pitwall passes no --model or --effort, from its documented
// settings files and environment variables. Every file is a made-up one in a temp directory: the
// tests never read your ~/.claude or the machine's managed settings.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORK_PATH, type WorkSettings } from '../shared/protocol.js';
import {
  canonicalModel,
  claudeDefaults,
  createClaudeDefaultsReader,
  localSettingsRoot,
  managedSettingsDir,
  modelEffort,
  readClaudeSettings,
  readManagedSettings,
  resolveEffort,
  resolveModel,
  type ClaudeSettingsFile,
  type ClaudeSettingsPaths,
  type ClaudeSources,
} from './claudeDefaults.js';
import { BUILT_IN_WORK, createWorkStore, emptyChoices, registerWork } from './work.js';

const user = (fields: Omit<ClaudeSettingsFile, 'scope'>): ClaudeSettingsFile => ({ scope: 'user', ...fields });
const project = (fields: Omit<ClaudeSettingsFile, 'scope'>): ClaudeSettingsFile => ({ scope: 'project', ...fields });
const local = (fields: Omit<ClaudeSettingsFile, 'scope'>): ClaudeSettingsFile => ({ scope: 'local', ...fields });
const managed = (fields: Omit<ClaudeSettingsFile, 'scope'>): ClaudeSettingsFile => ({ scope: 'managed', ...fields });
const sources = (files: ClaudeSettingsFile[], env: Record<string, string> = {}): ClaudeSources => ({ files, env });

describe('the model, with no --model', () => {
  it('takes ANTHROPIC_MODEL over any file, and a settings file\'s env over the shell\'s', () => {
    expect(resolveModel(sources([user({ model: 'opus' })], { ANTHROPIC_MODEL: 'sonnet' }))).toEqual({ value: 'sonnet', source: { kind: 'variable', name: 'ANTHROPIC_MODEL' } });
    expect(resolveModel(sources([project({ env: { ANTHROPIC_MODEL: 'haiku' } }), user({ model: 'opus' })], { ANTHROPIC_MODEL: 'sonnet' }))).toEqual({
      value: 'haiku',
      source: { kind: 'variable', name: 'ANTHROPIC_MODEL', scope: 'project' },
    });
    // An empty value in a file's env cancels the shell's.
    expect(resolveModel(sources([user({ model: 'opus', env: { ANTHROPIC_MODEL: '' } })], { ANTHROPIC_MODEL: 'sonnet' }))).toEqual({ value: 'opus', source: { kind: 'setting', key: 'model', scope: 'user' } });
  });

  it('takes `model` from the highest file: managed, local, project, then user', () => {
    const files = [managed({}), local({ model: 'claude-sonnet-5-5' }), project({ model: 'haiku' }), user({ model: 'opus' })];
    expect(resolveModel(sources(files))).toEqual({ value: 'claude-sonnet-5-5', source: { kind: 'setting', key: 'model', scope: 'local' } });
    expect(resolveModel(sources(files.slice(2)))).toEqual({ value: 'haiku', source: { kind: 'setting', key: 'model', scope: 'project' } });
    expect(resolveModel(sources([managed({ model: 'fable' }), ...files.slice(1)]))).toEqual({ value: 'fable', source: { kind: 'setting', key: 'model', scope: 'managed' } });
  });

  it('falls back to ANTHROPIC_DEFAULT_MODEL, except its documented exceptions, then to your account', () => {
    expect(resolveModel(sources([user({})], { ANTHROPIC_DEFAULT_MODEL: 'sonnet' }))).toEqual({ value: 'sonnet', source: { kind: 'variable', name: 'ANTHROPIC_DEFAULT_MODEL' } });
    for (const ignored of ['default', 'inherit', 'opusplan', 'haiku']) expect(resolveModel(sources([], { ANTHROPIC_DEFAULT_MODEL: ignored }))).toEqual({ source: { kind: 'account' } });
    // `model: "default"` clears an override, back to the account's default.
    expect(resolveModel(sources([user({ model: 'default' })]))).toEqual({ source: { kind: 'account' } });
    expect(resolveModel(sources([]))).toEqual({ source: { kind: 'account' } });
  });
});

describe('aliases and models', () => {
  it('resolves an alias on the Anthropic API, as ANTHROPIC_DEFAULT_<ALIAS>_MODEL pins it, and not on another provider', () => {
    expect(canonicalModel('opus', sources([]))).toBe('claude-opus-5-5');
    expect(canonicalModel('opus[1m]', sources([]))).toBe('claude-opus-5-5');
    expect(canonicalModel('fable', sources([]))).toBe('claude-fable-5-1');
    expect(canonicalModel('haiku', sources([], { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001' }))).toBe('claude-haiku-4-5');
    expect(canonicalModel('sonnet', sources([], { CLAUDE_CODE_USE_BEDROCK: '1' }))).toBeUndefined();
    expect(canonicalModel('best', sources([]))).toBeUndefined();
    expect(canonicalModel('claude-sonnet-5-20260101', sources([]))).toBe('claude-sonnet-5');
  });

  it("knows each model's own effort as documented", () => {
    expect(modelEffort('claude-opus-5-5')).toEqual({ value: 'medium' });
    expect(modelEffort('claude-haiku-5-5')).toEqual({ value: 'medium' });
    expect(modelEffort('claude-fable-5-1')).toEqual({ value: 'high' });
    expect(modelEffort('claude-opus-4-7')).toEqual({ value: 'xhigh' });
    expect(modelEffort('claude-sonnet-4-6')).toEqual({ value: 'high' });
    // Older than the list: no effort levels. Newer: not known yet.
    expect(modelEffort('claude-haiku-4-5')).toEqual({});
    expect(modelEffort('claude-opus-6')).toBeUndefined();
  });
});

describe('the effort, with no --effort', () => {
  it('takes CLAUDE_CODE_EFFORT_LEVEL first, `auto` or `unset` for none sent', () => {
    const files = [user({ modelSettings: { 'claude-opus-5-5': { effortLevel: 'low' } } })];
    expect(resolveEffort('opus', sources(files, { CLAUDE_CODE_EFFORT_LEVEL: 'high' }))).toEqual({ value: 'high', source: { kind: 'variable', name: 'CLAUDE_CODE_EFFORT_LEVEL' } });
    expect(resolveEffort('opus', sources(files, { CLAUDE_CODE_EFFORT_LEVEL: 'unset' }))).toEqual({ value: 'auto', source: { kind: 'variable', name: 'CLAUDE_CODE_EFFORT_LEVEL' } });
    // A kind that drops it from its environment still gets it from a file's env.
    expect(resolveEffort('opus', sources(files, { CLAUDE_CODE_EFFORT_LEVEL: 'high' }), false)).toEqual({ value: 'low', source: { kind: 'setting', key: 'modelSettings', scope: 'user' } });
    expect(resolveEffort('opus', sources([managed({ env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' } })]), false)).toEqual({ value: 'max', source: { kind: 'variable', name: 'CLAUDE_CODE_EFFORT_LEVEL', scope: 'managed' } });
  });

  it("takes the highest file with a level for the model, the model's entry over the file's own within one", () => {
    const files = [project({ effortLevel: 'high', modelSettings: { opus: { effortLevel: 'xhigh' } } }), user({ modelSettings: { 'claude-sonnet-5-5': { effortLevel: 'low' } } })];
    expect(resolveEffort('claude-opus-5-5', sources(files))).toEqual({ value: 'xhigh', source: { kind: 'setting', key: 'modelSettings', scope: 'project' } });
    // The project's top-level level applies to every model, so it beats the user file's saved Sonnet level.
    expect(resolveEffort('sonnet', sources(files))).toEqual({ value: 'high', source: { kind: 'setting', key: 'effortLevel', scope: 'project' } });
    // `max` isn't a level either key accepts.
    expect(resolveEffort('sonnet', sources([user({ modelSettings: { sonnet: { effortLevel: 'max' } } })]))).toEqual({ value: 'medium', source: { kind: 'model' } });
  });

  it("ignores a user file's top-level effortLevel from Opus 5.5 on, but not before", () => {
    const files = [user({ effortLevel: 'xhigh' })];
    expect(resolveEffort('opus', sources(files))).toEqual({ value: 'medium', source: { kind: 'model' } });
    expect(resolveEffort('claude-opus-5', sources(files))).toEqual({ value: 'xhigh', source: { kind: 'setting', key: 'effortLevel', scope: 'user' } });
  });

  it('caps it at the lowest maxEffortLevel, a model\'s own cap replacing its file\'s', () => {
    expect(resolveEffort('opus', sources([managed({ maxEffortLevel: 'high' }), user({ maxEffortLevel: 'low' })], { CLAUDE_CODE_EFFORT_LEVEL: 'max' }))).toEqual({
      value: 'low',
      source: { kind: 'setting', key: 'maxEffortLevel', scope: 'user' },
    });
    expect(resolveEffort('opus', sources([user({ maxEffortLevel: 'low', modelSettings: { opus: { maxEffortLevel: 'max' } } })], { CLAUDE_CODE_EFFORT_LEVEL: 'high' }))).toEqual({
      value: 'high',
      source: { kind: 'variable', name: 'CLAUDE_CODE_EFFORT_LEVEL' },
    });
  });

  it("says only what it can when the model isn't known", () => {
    expect(resolveEffort(undefined, sources([]))).toEqual({ source: { kind: 'model' } });
    expect(resolveEffort(undefined, sources([project({ effortLevel: 'low' })]))).toEqual({ value: 'low', source: { kind: 'setting', key: 'effortLevel', scope: 'project' } });
    expect(resolveEffort(undefined, sources([user({ effortLevel: 'low' })]))).toEqual({ source: { kind: 'model' } });
    expect(resolveEffort(undefined, sources([user({ modelSettings: { opus: { effortLevel: 'high' } } }), user({ effortLevel: 'low' })]))).toEqual({ source: { kind: 'model' } });
    expect(resolveEffort('claude-haiku-4-5', sources([]))).toEqual({ value: 'none', source: { kind: 'model' } });
  });
});

describe('each kind of work', () => {
  it('gives sessions every file and the environment, and the -p kinds the managed settings alone, recaps and the supervisor without CLAUDE_CODE_EFFORT_LEVEL', () => {
    const read = { session: [managed({}), project({ model: 'haiku' }), user({ model: 'sonnet', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } })], managed: [managed({})] };
    const layers = { builtIn: BUILT_IN_WORK, config: emptyChoices(), overrides: emptyChoices() };
    const defaults = claudeDefaults(read, { CLAUDE_CODE_EFFORT_LEVEL: 'xhigh' }, layers, '/x');
    expect(defaults.dir).toBe('/x');
    expect(defaults.model.session).toEqual({ value: 'haiku', source: { kind: 'setting', key: 'model', scope: 'project' } });
    expect(defaults.model.subagents).toEqual({ value: 'haiku', source: { kind: 'variable', name: 'CLAUDE_CODE_SUBAGENT_MODEL', scope: 'user' } });
    expect(defaults.model.recaps).toEqual({ source: { kind: 'account' } });
    expect(defaults.effort.session.default).toEqual({ value: 'xhigh', source: { kind: 'variable', name: 'CLAUDE_CODE_EFFORT_LEVEL' } });
    expect(defaults.effort.relay.haiku).toEqual({ value: 'xhigh', source: { kind: 'variable', name: 'CLAUDE_CODE_EFFORT_LEVEL' } });
    // pitwall's own models get theirs: recaps' Haiku 5.5 and the supervisor's Opus 5.5.
    expect(defaults.effort.recaps['claude-haiku-5-5']).toEqual({ value: 'medium', source: { kind: 'model' } });
    expect(defaults.effort.supervisor['claude-opus-5-5']).toEqual({ value: 'medium', source: { kind: 'model' } });
    expect(Object.keys(defaults.effort.supervisor)).toEqual(['default', 'opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5']);
    expect(defaults.effort.subagents).toEqual({});
  });
});

describe('the files', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'pitwall-claude-defaults-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const write = (file: string, content: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  };
  const paths = (): ClaudeSettingsPaths => ({ configDir: path.join(tmp, 'home', '.claude'), managedDir: path.join(tmp, 'managed'), home: path.join(tmp, 'home') });

  it('knows where managed settings live on each platform', () => {
    expect(managedSettingsDir('darwin')).toBe('/Library/Application Support/ClaudeCode');
    expect(managedSettingsDir('linux')).toBe('/etc/claude-code');
    expect(managedSettingsDir('win32')).toBe('C:\\Program Files\\ClaudeCode');
  });

  it('merges managed-settings.json, then managed-settings.d by name, leaving out hidden files', async () => {
    write(path.join(tmp, 'managed', 'managed-settings.json'), { model: 'opus', env: { A: '1' } });
    write(path.join(tmp, 'managed', 'managed-settings.d', '20-b.json'), { model: 'haiku', env: { B: '2' } });
    write(path.join(tmp, 'managed', 'managed-settings.d', '10-a.json'), { model: 'sonnet' });
    write(path.join(tmp, 'managed', 'managed-settings.d', '.30-hidden.json'), { model: 'fable' });
    expect(await readManagedSettings(path.join(tmp, 'managed'))).toEqual({ scope: 'managed', model: 'haiku', env: { A: '1', B: '2' } });
    expect(await readManagedSettings(path.join(tmp, 'none'))).toBeUndefined();
  });

  it("finds the local file at the repository's root, the main checkout's for a worktree, and the directory outside one", async () => {
    const repo = path.join(tmp, 'home', 'code', 'app');
    mkdirSync(path.join(repo, '.git', 'worktrees', 'w1'), { recursive: true });
    mkdirSync(path.join(repo, 'packages', 'web'), { recursive: true });
    expect(await localSettingsRoot(path.join(repo, 'packages', 'web'), paths().home)).toBe(repo);
    const tree = path.join(repo, '.worktrees', 'w1');
    write(path.join(tree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'w1')}\n`);
    expect(await localSettingsRoot(tree, paths().home)).toBe(repo);
    const loose = path.join(tmp, 'loose');
    mkdirSync(loose);
    expect(await localSettingsRoot(loose, paths().home)).toBe(loose);
    // A repository at your home directory leaves the file in the directory.
    mkdirSync(path.join(paths().home, '.git'), { recursive: true });
    mkdirSync(path.join(paths().home, 'notes'), { recursive: true });
    expect(await localSettingsRoot(path.join(paths().home, 'notes'), paths().home)).toBe(path.join(paths().home, 'notes'));
  });

  it('reads them in order, skipping a broken one, with project settings only for a directory', async () => {
    const repo = path.join(tmp, 'code', 'app');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(path.join(paths().configDir, 'settings.json'), { model: 'opus', effortLevel: 'high' });
    write(path.join(repo, '.claude', 'settings.json'), { model: 'sonnet' });
    write(path.join(repo, '.claude', 'settings.local.json'), '{ "model": "haiku", ');
    write(path.join(tmp, 'managed', 'managed-settings.json'), { maxEffortLevel: 'medium' });
    const withDir = await readClaudeSettings(paths(), repo);
    expect(withDir.session.map((file) => file.scope)).toEqual(['managed', 'project', 'user']);
    expect(withDir.managed).toEqual([{ scope: 'managed', maxEffortLevel: 'medium' }]);
    const without = await readClaudeSettings(paths());
    expect(without.session.map((file) => file.scope)).toEqual(['managed', 'user']);
  });

  it('serves them on GET /api/work, with ?dir= only once checked, and on POST\'s answer', async () => {
    const repo = path.join(tmp, 'code', 'app');
    write(path.join(paths().configDir, 'settings.json'), { model: 'claude-opus-5-5' });
    write(path.join(repo, '.claude', 'settings.json'), { model: 'sonnet' });
    const store = createWorkStore({ claude: createClaudeDefaultsReader({ env: () => ({}), paths }) });
    const app = new Hono();
    const asked: string[] = [];
    registerWork(app, store, async (dir) => {
      asked.push(dir);
      return dir === repo ? repo : undefined;
    });
    const get = async (query = '') => (await (await app.request(`${WORK_PATH}${query}`)).json()) as WorkSettings;
    expect((await get()).claude?.model.session).toEqual({ value: 'claude-opus-5-5', source: { kind: 'setting', key: 'model', scope: 'user' } });
    const inRepo = await get(`?dir=${encodeURIComponent(repo)}`);
    expect(inRepo.claude?.dir).toBe(repo);
    expect(inRepo.claude?.model.session).toEqual({ value: 'sonnet', source: { kind: 'setting', key: 'model', scope: 'project' } });
    const outside = await get(`?dir=${encodeURIComponent('/etc')}`);
    expect(outside.claude?.dir).toBeUndefined();
    expect(asked).toEqual([repo, '/etc']);
    const posted = await app.request(WORK_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ overrides: {} }) });
    expect(((await posted.json()) as WorkSettings).claude?.model.session.value).toBe('claude-opus-5-5');
    // Without a reader, as in the server's own default store, there's no `claude`.
    const bare = new Hono();
    registerWork(bare, createWorkStore());
    expect(((await (await bare.request(WORK_PATH)).json()) as WorkSettings).claude).toBeUndefined();
  });
});
