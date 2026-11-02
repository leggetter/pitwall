// The model and effort for each kind of work pitwall starts (W119, #114): pitwall's own defaults, the
// config file's `work` block (D24), and the app's overrides, which pitwall's server keeps for its run.
//
//   GET  WORK_PATH   WorkSettings: each layer, and what applies
//   POST WORK_PATH   a WorkUpdate, the whole set of overrides; answers WorkSettings, or 400 { error }
//
// Both are under /api/*, so the server's checks come first (server.ts): Host, then Origin, then the
// token or the apiKey, and for POST, the apiKey and an Origin. The overrides are never written to the
// config file, and never kept in the browser: they change processes this server starts, so they live
// here, and end with it.
//
// What Claude Code documents, and so all pitwall uses (code.claude.com/docs, read for W119):
//
// - `--model <alias or full name>` and `--effort <low|medium|high|xhigh|max>` on `claude --bg` and
//   `claude -p` (cli-reference; agent-view, "Set the model, effort and fast mode").
// - CLAUDE_CODE_EFFORT_LEVEL takes precedence over `--effort` (env-vars), so a process given an effort
//   here doesn't inherit it (withEffort()).
// - A session's sub-agents: CLAUDE_CODE_SUBAGENT_MODEL, "a model alias or model ID", used for those
//   whose definition sets no `model` and whose call passes none (sub-agents, "Choose a model"). Their
//   effort has no setting of its own: an agent definition's `effort`, the Agent tool's per-call
//   `effort`, or CLAUDE_CODE_EFFORT_LEVEL, which sets the whole session's. So pitwall offers none.
// - A model Claude Code doesn't know fails on the first request, "There's an issue with the selected
//   model (<name>)", and exit 1 from `-p`; an effort it doesn't know is ignored with a warning. pitwall
//   checks both first (isWorkModel(), isEffortLevel()), and says so in its own words when a model it
//   allowed is refused all the same (isModelRejection()).
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  isEffortLevel,
  RECAP_EFFORT_LEVELS,
  isWorkModel,
  RECAP_MODEL,
  SUPERVISOR_MODEL,
  WORK_DEFAULT,
  WORK_KINDS,
  WORK_PATH,
  type WorkChoice,
  type WorkChoices,
  type WorkKind,
  type WorkSettings,
} from '../shared/protocol.js';
import { RELAY_MODEL } from './relayPrompt.js';

/** pitwall's own model and effort for each kind of work: today's behaviour, before W119. */
export const BUILT_IN_WORK: Readonly<WorkChoices> = Object.freeze({
  session: {},
  subagents: {},
  supervisor: { model: SUPERVISOR_MODEL },
  recaps: { model: RECAP_MODEL },
  relay: { model: RELAY_MODEL },
});

/** What each kind is called in a message. */
export const WORK_NAMES: Readonly<Record<WorkKind, string>> = {
  session: 'sessions',
  subagents: "sessions' sub-agents",
  supervisor: 'the supervisor',
  recaps: 'recaps',
  relay: 'the relay',
};

/** Why a session's sub-agents take no effort, for the config file's error and the route's. */
export const SUBAGENT_EFFORT_ERROR =
  "can't be set: Claude Code has no effort setting for a session's sub-agents apart from the session's own (an agent definition's effort, or CLAUDE_CODE_EFFORT_LEVEL, which sets the whole session's). Remove it.";

/** The words for a bad model, after its key. Never the value itself (D24). */
export function modelProblem(kind: WorkKind): string {
  const aliases = kind === 'subagents' ? 'opus, sonnet, haiku or fable' : 'opus, sonnet, haiku, fable, best, opusplan, opus[1m] or sonnet[1m]';
  return `must be a Claude Code model: ${aliases}, a full model name such as claude-opus-5-5, or "${WORK_DEFAULT}" for Claude Code's own`;
}

export const EFFORT_PROBLEM = `must be low, medium, high, xhigh or max, or "${WORK_DEFAULT}" for Claude Code's own`;

/** Why recaps take at most `high` (RECAP_EFFORT_LEVELS). */
export const RECAP_EFFORT_PROBLEM = `must be low, medium or high, or "${WORK_DEFAULT}" for Claude Code's own: a recap may write at most 4,096 tokens, thinking included, and xhigh or max could use them up before the answer`;

/**
 * One kind's `{ model?, effort? }`, checked: `key` is where it is, such as `work.recaps`, for
 * messages. `fail` throws or returns; `unknown` is told of each key it doesn't know. Never quotes a
 * value.
 */
export function parseWorkChoice(
  kind: WorkKind,
  value: unknown,
  key: string,
  fail: (key: string, message: string) => never,
  unknown: (key: string) => void,
): WorkChoice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(key, 'must be an object, such as { "model": "sonnet", "effort": "high" }');
  const entry = value as Record<string, unknown>;
  for (const name of Object.keys(entry)) if (name !== 'model' && name !== 'effort') unknown(`${key}.${name}`);
  const choice: WorkChoice = {};
  if (Object.hasOwn(entry, 'model')) {
    const model = entry.model;
    if (model !== WORK_DEFAULT && !isWorkModel(model, kind)) return fail(`${key}.model`, modelProblem(kind));
    choice.model = model;
  }
  if (Object.hasOwn(entry, 'effort')) {
    if (kind === 'subagents') return fail(`${key}.effort`, SUBAGENT_EFFORT_ERROR);
    const effort = entry.effort;
    if (effort !== WORK_DEFAULT && !isEffortLevel(effort)) return fail(`${key}.effort`, EFFORT_PROBLEM);
    if (kind === 'recaps' && effort !== WORK_DEFAULT && !(RECAP_EFFORT_LEVELS as readonly string[]).includes(effort)) return fail(`${key}.effort`, RECAP_EFFORT_PROBLEM);
    choice.effort = effort;
  }
  return choice;
}

/** Each kind of `value`, checked as parseWorkChoice() checks one; kinds it doesn't name are empty. */
export function parseWorkChoices(
  value: unknown,
  key: string,
  fail: (key: string, message: string) => never,
  unknown: (key: string) => void,
): WorkChoices {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(key, 'must be an object, such as { "session": { "model": "opus", "effort": "high" } }');
  }
  const entry = value as Record<string, unknown>;
  const choices = emptyChoices();
  for (const name of Object.keys(entry)) {
    if (!(WORK_KINDS as readonly string[]).includes(name)) unknown(`${key}.${name}`);
  }
  for (const kind of WORK_KINDS) {
    if (Object.hasOwn(entry, kind)) choices[kind] = parseWorkChoice(kind, entry[kind], `${key}.${kind}`, fail, unknown);
  }
  return choices;
}

export function emptyChoices(): WorkChoices {
  return { session: {}, subagents: {}, supervisor: {}, recaps: {}, relay: {} };
}

/** Field by field: the first layer that has it. */
export function mergeChoices(...layers: WorkChoice[]): WorkChoice {
  const merged: WorkChoice = {};
  for (const layer of layers) {
    if (merged.model === undefined && layer.model !== undefined) merged.model = layer.model;
    if (merged.effort === undefined && layer.effort !== undefined) merged.effort = layer.effort;
  }
  return merged;
}

/** The flags for `choice`: `--model` and `--effort`, each left out when absent or WORK_DEFAULT. */
export function workArgs(choice: WorkChoice): string[] {
  const args: string[] = [];
  if (choice.model !== undefined && choice.model !== WORK_DEFAULT) args.push('--model', choice.model);
  if (choice.effort !== undefined && choice.effort !== WORK_DEFAULT) args.push('--effort', choice.effort);
  return args;
}

/** Whether `choice` sets an effort, so `--effort` is passed. */
export function setsEffort(choice: WorkChoice): boolean {
  return choice.effort !== undefined && choice.effort !== WORK_DEFAULT;
}

/**
 * `env` for a process given `choice`: without CLAUDE_CODE_EFFORT_LEVEL when it sets an effort, since
 * that variable takes precedence over `--effort` (env-vars, "Precedence"); with
 * CLAUDE_CODE_SUBAGENT_MODEL when `subagents` sets a model, and as inherited otherwise. A new object;
 * `env` is left alone.
 */
export function withEffort<T extends NodeJS.ProcessEnv | Record<string, string>>(env: T, choice: WorkChoice, subagents: WorkChoice = {}): T {
  const result = { ...env };
  if (setsEffort(choice)) {
    for (const name of Object.keys(result)) if (name.toUpperCase() === 'CLAUDE_CODE_EFFORT_LEVEL') delete result[name];
  }
  if (subagents.model !== undefined && subagents.model !== WORK_DEFAULT) {
    for (const name of Object.keys(result)) if (name.toUpperCase() === 'CLAUDE_CODE_SUBAGENT_MODEL') delete result[name];
    (result as Record<string, string>).CLAUDE_CODE_SUBAGENT_MODEL = subagents.model;
  }
  return result;
}

/**
 * Whether Claude Code's answer says it refused the model: `-p`'s result, "There's an issue with the
 * selected model (<name>). It may not exist or you may not have access to it." (v2.1.316), or its
 * stderr's `unrecognized_model`.
 */
export function isModelRejection(text: string): boolean {
  return /issue with the selected model|unrecognized_model/i.test(text);
}

/** pitwall's words for a model Claude Code refused, for `kind`. */
export function modelRejectedMessage(kind: WorkKind): string {
  return `Claude Code didn't accept the model set for ${WORK_NAMES[kind]}: it may not exist, or your account can't use it. Choose another in Preferences, under Models and effort, or in the config file's "work.${kind}".`;
}

/** The overrides, and what applies, for this run. */
export interface WorkStore {
  /** What applies to `kind` now: the override, else the config file's, else pitwall's own, field by field. */
  choice(kind: WorkKind): WorkChoice;
  settings(): WorkSettings;
  /** Replaces the overrides with `body`'s, a WorkUpdate, once it passes every check. */
  update(body: unknown): { ok: true; settings: WorkSettings } | { ok: false; error: string };
}

export interface WorkStoreOptions {
  /** The config file's `work` block, checked (LoadedConfig.work). */
  config?: WorkChoices;
  /** The config file's path, when one was read. */
  configFile?: string;
}

export function createWorkStore(options: WorkStoreOptions = {}): WorkStore {
  const config = options.config ?? emptyChoices();
  let overrides = emptyChoices();
  const choice = (kind: WorkKind) => mergeChoices(overrides[kind], config[kind], BUILT_IN_WORK[kind]);
  const settings = (): WorkSettings => {
    const effective = emptyChoices();
    for (const kind of WORK_KINDS) effective[kind] = choice(kind);
    return {
      builtIn: copy(BUILT_IN_WORK),
      config: copy(config),
      overrides: copy(overrides),
      effective,
      ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
    };
  };
  return {
    choice,
    settings,
    update(body) {
      if (typeof body !== 'object' || body === null || Array.isArray(body) || !Object.hasOwn(body, 'overrides')) {
        return { ok: false, error: 'The body must be { "overrides": { ... } }.' };
      }
      class Refused extends Error {}
      const fail = (key: string, message: string): never => {
        throw new Refused(`${JSON.stringify(key)} ${message}.`.replace(/\.\.$/, '.'));
      };
      const unknown = (key: string) => fail(key, "isn't a setting pitwall knows");
      try {
        overrides = parseWorkChoices((body as { overrides: unknown }).overrides, 'overrides', fail, unknown);
      } catch (error) {
        if (error instanceof Refused) return { ok: false, error: error.message };
        throw error;
      }
      return { ok: true, settings: settings() };
    },
  };
}

function copy(choices: Readonly<WorkChoices>): WorkChoices {
  const result = emptyChoices();
  for (const kind of WORK_KINDS) result[kind] = { ...choices[kind] };
  return result;
}

/** The longest POST body: five kinds of two short strings each fit in well under 1 KiB. */
const MAX_WORK_BODY_BYTES = 4 * 1024;

/** GET and POST WORK_PATH. Call it after the /api/* checks, as ServerInternals.routes does. */
export function registerWork(app: Hono, store: WorkStore): void {
  app.get(WORK_PATH, (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(store.settings());
  });
  app.post(
    WORK_PATH,
    bodyLimit({ maxSize: MAX_WORK_BODY_BYTES, onError: (c) => c.json({ error: 'The request is too large.' }, 413) }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      if (!/^application\/json\s*(;|$)/i.test(c.req.header('content-type') ?? '')) return c.json({ error: 'Send the request as application/json.' }, 415);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "The body isn't valid JSON." }, 400);
      }
      const result = store.update(body);
      if (!result.ok) return c.json({ error: result.error }, 400);
      return c.json(result.settings);
    },
  );
}
