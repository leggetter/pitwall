// The model and effort for each kind of work pitwall starts (W119, #114): the API calls, the check
// of what the server answers, and the words and choices Preferences' Models and effort section and
// New session's Model and Effort fields show. pitwall's server keeps the overrides for its run
// (src/server/work.ts); the page never stores them.

import {
  EFFORT_LEVELS,
  isEffortLevel,
  isWorkModel,
  RECAP_EFFORT_LEVELS,
  SUBAGENT_MODEL_ALIASES,
  WORK_DEFAULT,
  WORK_KINDS,
  WORK_PATH,
  type WorkChoice,
  type WorkChoices,
  type WorkKind,
  type WorkSettings,
} from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';

/** Each kind's name in Preferences. */
export const WORK_LABELS: Readonly<Record<WorkKind, string>> = {
  session: 'Sessions',
  subagents: "Sessions' sub-agents",
  supervisor: 'Supervisor',
  recaps: 'Recaps',
  relay: 'Relay',
};

/** What each kind is, and when a change reaches it. */
export const WORK_HINTS: Readonly<Record<WorkKind, string>> = {
  session: 'New session, and resuming one pitwall started. From the next session you start.',
  subagents: "For sub-agents whose definition names no model, from the next session you start. Their effort is the session's: Claude Code has no separate setting for it.",
  supervisor: 'From its next start.',
  recaps: 'From the next recap. At most high effort: a recap may write 4,096 tokens, thinking included.',
  relay: 'Passes on the messages you write to interactive sessions. From its next start.',
};

/** The section's words: where the overrides live, and how they relate to the config file. */
export const WORK_SECTION_TEXT =
  "pitwall's server keeps these until it stops. They don't change the config file: its \"work\" block sets the defaults.";

/** Claude Code's own default, as a choice. */
export const CLAUDE_DEFAULT_TEXT = "Claude Code's default";

/** The aliases offered in Preferences and New session, besides what the layers already name. */
export const OFFERED_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A choice the server sent, kept only where each field is one pitwall allows. */
function readChoice(value: unknown, kind: WorkKind): WorkChoice {
  if (!isRecord(value)) return {};
  const choice: WorkChoice = {};
  if (value.model === WORK_DEFAULT || isWorkModel(value.model, kind)) choice.model = value.model as string;
  if (kind !== 'subagents' && (value.effort === WORK_DEFAULT || isEffortLevel(value.effort)) && (kind !== 'recaps' || value.effort === WORK_DEFAULT || (RECAP_EFFORT_LEVELS as readonly unknown[]).includes(value.effort))) {
    choice.effort = value.effort as WorkChoice['effort'];
  }
  return choice;
}

function readChoices(value: unknown): WorkChoices | undefined {
  if (!isRecord(value)) return undefined;
  const choices = {} as WorkChoices;
  for (const kind of WORK_KINDS) choices[kind] = readChoice(value[kind], kind);
  return choices;
}

/** GET WORK_PATH's answer, read defensively, or undefined when it isn't one. */
export function readWorkSettings(value: unknown): WorkSettings | undefined {
  if (!isRecord(value)) return undefined;
  const builtIn = readChoices(value.builtIn);
  const config = readChoices(value.config);
  const overrides = readChoices(value.overrides);
  const effective = readChoices(value.effective);
  if (!builtIn || !config || !overrides || !effective) return undefined;
  return { builtIn, config, overrides, effective, ...(typeof value.configFile === 'string' ? { configFile: value.configFile } : {}) };
}

export async function fetchWorkSettings(api: Pick<ApiClient, 'get'>, signal?: AbortSignal): Promise<WorkSettings | undefined> {
  const result = await api.get(WORK_PATH, signal === undefined ? {} : { signal });
  return result.kind === 'ok' ? readWorkSettings(result.body) : undefined;
}

/** POSTs the whole set of overrides. The server's answer, or why not, in its words or pitwall's. */
export async function saveWorkOverrides(
  api: Pick<ApiClient, 'post'>,
  overrides: Partial<WorkChoices>,
): Promise<{ ok: true; settings: WorkSettings } | { ok: false; error: string }> {
  const result = await api.post(WORK_PATH, { overrides });
  if (result.kind === 'ok') {
    const settings = readWorkSettings(result.body);
    if (settings) return { ok: true, settings };
  }
  const body = result.kind === 'failed' && isRecord(result.body) && typeof result.body.error === 'string' ? result.body.error : undefined;
  return { ok: false, error: body ?? "pitwall couldn't save that choice. Try again." };
}

/** `overrides` with `kind`'s `field` set to `value`, or without it for ''. A new object. */
export function withOverride(overrides: WorkChoices, kind: WorkKind, field: 'model' | 'effort', value: string): WorkChoices {
  const next = { ...overrides, [kind]: { ...overrides[kind] } } as WorkChoices;
  if (value === '') delete next[kind][field];
  else (next[kind] as Record<string, string>)[field] = value;
  return next;
}

/** A value as shown: Claude Code's default for none or WORK_DEFAULT, else the value itself. */
export function valueText(value: string | undefined): string {
  return value === undefined || value === WORK_DEFAULT ? CLAUDE_DEFAULT_TEXT : value;
}

/** What applies without an override, and where it comes from: the config file, or pitwall's own. */
export function defaultOf(settings: WorkSettings, kind: WorkKind, field: 'model' | 'effort'): { value?: string; source: 'config' | 'pitwall' } {
  const config = settings.config[kind][field];
  if (config !== undefined) return { value: config, source: 'config' };
  const builtIn = settings.builtIn[kind][field];
  return builtIn === undefined ? { source: 'pitwall' } : { value: builtIn, source: 'pitwall' };
}

/** The first option's words: "Default: opus, from the config file", or "Default: Claude Code's". */
export function defaultText(settings: WorkSettings, kind: WorkKind, field: 'model' | 'effort'): string {
  const { value, source } = defaultOf(settings, kind, field);
  if (value === undefined || value === WORK_DEFAULT) return source === 'config' ? "Default: Claude Code's, from the config file" : "Default: Claude Code's";
  return source === 'config' ? `Default: ${value}, from the config file` : `Default: ${value}`;
}

/**
 * The choices after the default, as values: Claude Code's default, when the default isn't already
 * it; the offered aliases, the sub-agents' four only for them; and any full name a layer names, so
 * a choice made in the config file is one you can come back to. For effort, the five levels.
 */
export function choiceValues(settings: WorkSettings | undefined, kind: WorkKind, field: 'model' | 'effort'): string[] {
  const fallback = settings === undefined ? undefined : defaultOf(settings, kind, field).value;
  const values: string[] = fallback === undefined || fallback === WORK_DEFAULT ? [] : [WORK_DEFAULT];
  // Recaps stop at high: a recap's output cap counts thinking (RECAP_EFFORT_LEVELS).
  if (field === 'effort') return [...values, ...(kind === 'recaps' ? RECAP_EFFORT_LEVELS : EFFORT_LEVELS)];
  const named = settings === undefined ? [] : [settings.overrides, settings.config, settings.builtIn].map((layer) => layer[kind].model);
  const aliases: readonly string[] = kind === 'subagents' ? SUBAGENT_MODEL_ALIASES : OFFERED_MODELS;
  for (const value of [...aliases, ...named]) {
    if (value !== undefined && value !== WORK_DEFAULT && !values.includes(value)) values.push(value);
  }
  return values;
}

/** An option's words for a value from choiceValues(). */
export function choiceText(value: string): string {
  return value === WORK_DEFAULT ? CLAUDE_DEFAULT_TEXT : value;
}

/**
 * What a kind of work has cost, at API list prices, as `claude -p` reports them, for Preferences:
 * "$0.04", "under $0.01", or undefined when there's nothing to say.
 */
export function usdText(costUsd: number | undefined): string | undefined {
  if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0) return undefined;
  return costUsd < 0.005 ? 'under $0.01' : `$${costUsd.toFixed(2)}`;
}
