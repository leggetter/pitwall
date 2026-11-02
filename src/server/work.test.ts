// W119: the model and effort for each kind of work. The routes' checks and spawn's and resume's
// arguments are in actions.test.ts; the config file's block in config.test.ts; recaps' and the
// supervisor's in their own tests.
import { describe, expect, it } from 'vitest';
import { RECAP_MAX_OUTPUT_TOKENS, recapArgs } from '../recaps/prompt.js';
import { isWorkModel, RECAP_MODEL, SUPERVISOR_MODEL } from '../shared/protocol.js';
import { supervisorArgs } from '../supervisor/prompt.js';
import { relayArgs } from './relayPrompt.js';
import { BUILT_IN_WORK, RECAP_EFFORT_PROBLEM, createWorkStore, emptyChoices, isModelRejection, mergeChoices, withEffort, workArgs } from './work.js';

const flagsOf = (args: string[]) => args.flatMap((arg, i) => (arg === '--model' || arg === '--effort' ? [arg, args[i + 1]] : []));

describe('isWorkModel', () => {
  it("takes Claude Code's documented aliases and full model names, and nothing that could be read as another option", () => {
    for (const model of ['opus', 'sonnet', 'haiku', 'fable', 'best', 'opusplan', 'opus[1m]', 'sonnet[1m]', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1']) {
      expect(isWorkModel(model), model).toBe(true);
    }
    for (const model of ['', 'default', 'Opus', '-opus', '--model=x', 'opus haiku', 'claude-opus', 'claude-gpt-5', 'claude-opus-5-5-5-5', 'gpt-5', 7, undefined]) {
      expect(isWorkModel(model), String(model)).toBe(false);
    }
  });

  it("gives sub-agents only the aliases an agent definition's model takes", () => {
    for (const model of ['opus', 'sonnet', 'haiku', 'fable', 'claude-haiku-5-5']) expect(isWorkModel(model, 'subagents'), model).toBe(true);
    for (const model of ['best', 'opusplan', 'opus[1m]']) expect(isWorkModel(model, 'subagents'), model).toBe(false);
  });
});

describe('precedence: the app, then the config file, then pitwall', () => {
  it('merges field by field', () => {
    expect(mergeChoices({ effort: 'low' }, { model: 'opus', effort: 'high' }, { model: 'claude-opus-5-5' })).toEqual({ model: 'opus', effort: 'low' });
    expect(mergeChoices({}, {}, BUILT_IN_WORK.recaps)).toEqual({ model: RECAP_MODEL });
  });

  it("is today's behaviour with no config and no overrides", () => {
    const store = createWorkStore();
    expect(store.choice('session')).toEqual({});
    expect(store.choice('subagents')).toEqual({});
    expect(store.choice('supervisor')).toEqual({ model: SUPERVISOR_MODEL });
    expect(store.choice('recaps')).toEqual({ model: RECAP_MODEL });
    expect(store.choice('relay')).toEqual({ model: 'haiku' });
    expect(store.settings()).not.toHaveProperty('configFile');
  });

  it('puts an override over the config file, and "default" over both, until the overrides are replaced', () => {
    const store = createWorkStore({ config: { ...emptyChoices(), supervisor: { model: 'sonnet', effort: 'medium' } } });
    expect(store.choice('supervisor')).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(store.update({ overrides: { supervisor: { effort: 'xhigh' } } }).ok).toBe(true);
    expect(store.choice('supervisor')).toEqual({ model: 'sonnet', effort: 'xhigh' });
    expect(store.update({ overrides: { supervisor: { model: 'default' } } }).ok).toBe(true);
    expect(store.choice('supervisor')).toEqual({ model: 'default', effort: 'medium' });
    expect(workArgs(store.choice('supervisor'))).toEqual(['--effort', 'medium']);
    expect(store.update({ overrides: {} }).ok).toBe(true);
    expect(store.choice('supervisor')).toEqual({ model: 'sonnet', effort: 'medium' });
  });

  it('keeps recaps at high effort at most, since their output cap counts thinking, and says why', () => {
    const store = createWorkStore();
    for (const effort of ['low', 'medium', 'high', 'default']) expect(store.update({ overrides: { recaps: { effort } } }).ok, effort).toBe(true);
    for (const effort of ['xhigh', 'max']) {
      const result = store.update({ overrides: { recaps: { effort } } });
      expect(result).toEqual({ ok: false, error: `"overrides.recaps.effort" ${RECAP_EFFORT_PROBLEM}.` });
    }
    // The other kinds take every level.
    expect(store.update({ overrides: { supervisor: { effort: 'max' }, relay: { effort: 'xhigh' } } }).ok).toBe(true);
    expect(RECAP_EFFORT_PROBLEM).toContain(RECAP_MAX_OUTPUT_TOKENS.toLocaleString('en'));
  });

  it('copies what it answers, so a caller changing it changes nothing', () => {
    const store = createWorkStore();
    const settings = store.settings();
    settings.builtIn.recaps.model = 'opus';
    settings.overrides.recaps.model = 'opus';
    expect(store.choice('recaps')).toEqual({ model: RECAP_MODEL });
  });
});

describe('the arguments and environment each process gets', () => {
  it('the supervisor, recaps and the relay: their own model by default, the choice when given, none for "default"', () => {
    expect(flagsOf(supervisorArgs({ mcpConfig: '/x.json', settings: '{}' }))).toEqual(['--model', SUPERVISOR_MODEL]);
    expect(flagsOf(supervisorArgs({ mcpConfig: '/x.json', settings: '{}', model: 'sonnet', effort: 'low' }))).toEqual(['--model', 'sonnet', '--effort', 'low']);
    expect(flagsOf(recapArgs())).toEqual(['--model', RECAP_MODEL]);
    expect(flagsOf(recapArgs({ effort: 'low' }))).toEqual(['--model', RECAP_MODEL, '--effort', 'low']);
    expect(flagsOf(recapArgs({ model: 'default', effort: 'default' }))).toEqual([]);
    expect(flagsOf(relayArgs({ settings: '{}' }))).toEqual(['--model', 'haiku']);
    expect(flagsOf(relayArgs({ settings: '{}', model: 'claude-haiku-5-5', effort: 'medium' }))).toEqual(['--model', 'claude-haiku-5-5', '--effort', 'medium']);
    expect(flagsOf(relayArgs({ settings: '{}', model: 'default' }))).toEqual([]);
  });

  it('drops an inherited CLAUDE_CODE_EFFORT_LEVEL only when an effort is passed, and sets the sub-agents\' model only when chosen', () => {
    const env = { PATH: '/usr/bin', CLAUDE_CODE_EFFORT_LEVEL: 'max', CLAUDE_CODE_SUBAGENT_MODEL: 'opus' };
    expect(withEffort(env, {})).toEqual(env);
    expect(withEffort(env, { effort: 'default' })).toEqual(env);
    expect(withEffort(env, { effort: 'low' })).toEqual({ PATH: '/usr/bin', CLAUDE_CODE_SUBAGENT_MODEL: 'opus' });
    expect(withEffort(env, {}, { model: 'haiku' })).toEqual({ ...env, CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' });
    expect(withEffort(env, {}, { model: 'default' })).toEqual(env);
    // A new object: what it was given is unchanged.
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max');
  });

  it("recognises Claude Code's refusal of a model, as v2.1.316 prints it", () => {
    expect(isModelRejection("There's an issue with the selected model (claude-opus-9-9). It may not exist or you may not have access to it. Run --model to pick a different model.")).toBe(true);
    expect(isModelRejection('[claude-code:unrecognized_model] {"model":"claude-opus-9-9"}')).toBe(true);
    expect(isModelRejection('API Error: overloaded')).toBe(false);
  });
});
