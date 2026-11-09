// The model and effort for each kind of work pitwall starts (W119, #114): the API calls, the check
// of what the server answers, and the words and choices Preferences' Models and effort section and
// New session's Model and Effort fields show. pitwall's server keeps the overrides for its run
// (src/server/work.ts); the page never stores them.

import {
  EFFORT_LEVELS,
  isEffortLevel,
  isSkillName,
  OFFERED_WORK_MODELS,
  isWorkModel,
  NO_PROFILE,
  RECAP_EFFORT_LEVELS,
  SUBAGENT_MODEL_ALIASES,
  WORK_DEFAULT,
  WORK_KINDS,
  WORK_PATH,
  WORK_PROFILE_NAME_PATTERN,
  WORK_PROFILES_MAX,
  type ClaudeDefault,
  type ClaudeDefaults,
  type ClaudeDefaultSource,
  type ClaudeSettingsScope,
  type WorkChoice,
  type WorkChoices,
  type WorkKind,
  type WorkProfile,
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
  session:
    "New session on the None profile, the supervisor's new sessions, and resuming one pitwall started without a profile; a profile's own model and effort win. From the next session you start.",
  subagents:
    "For sub-agents whose definition names no model, in New session on the None profile, the supervisor's new sessions, and resuming one pitwall started without a profile; a profile's own wins. From the next session you start. Their effort is the session's: Claude Code has no separate setting for it.",
  supervisor: 'From its next start.',
  recaps: 'From the next recap. At most high effort: a recap may write 4,096 tokens, thinking included.',
  relay: 'Passes on the messages you write to interactive sessions. From its next start.',
};

/** The section's words: where the overrides live, and how they relate to the config file. */
export const WORK_SECTION_TEXT =
  "pitwall's server keeps these until it stops. They don't change the config file: its \"work\" block sets the defaults.";

/** The section's words on Claude Code's own defaults (W122), once the server has sent them. */
export const CLAUDE_DEFAULTS_TEXT =
  "Claude Code's own defaults are read from its settings files and your environment as this opens. A project's settings can change a session's, as New session shows, and your organization's default or policy from claude.ai can change any.";

/** Claude Code's own default, as a choice, when its value isn't known. */
export const CLAUDE_DEFAULT_TEXT = "Claude Code's default";

/** The aliases offered in Preferences and New session, besides what the layers already name. */
export const OFFERED_MODELS = OFFERED_WORK_MODELS;

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
  const claude = readClaudeDefaults(value.claude);
  const profiles = readProfiles(value.profiles);
  return {
    builtIn,
    config,
    overrides,
    effective,
    ...(typeof value.configFile === 'string' ? { configFile: value.configFile } : {}),
    ...(profiles === undefined ? {} : { profiles }),
    ...(claude === undefined ? {} : { claude }),
  };
}

/**
 * WorkSettings.profiles (W155), read defensively: a profile is kept only when its name and every field
 * it has pass the server's checks, and a name is kept once. Undefined when the answer has no list.
 */
export function readProfiles(value: unknown): WorkProfile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const profiles: WorkProfile[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, WORK_PROFILES_MAX + 4)) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !WORK_PROFILE_NAME_PATTERN.test(entry.name) || seen.has(entry.name.toLowerCase())) continue;
    if (entry.source !== 'built-in' && entry.source !== 'config') continue;
    if (entry.model !== undefined && entry.model !== WORK_DEFAULT && !isWorkModel(entry.model, 'session')) continue;
    if (entry.effort !== undefined && entry.effort !== WORK_DEFAULT && !isEffortLevel(entry.effort)) continue;
    if (entry.subagentModel !== undefined && entry.subagentModel !== WORK_DEFAULT && !isWorkModel(entry.subagentModel, 'subagents')) continue;
    if (entry.skill !== undefined && !isSkillName(entry.skill)) continue;
    seen.add(entry.name.toLowerCase());
    profiles.push({
      name: entry.name,
      source: entry.source,
      ...(entry.model === undefined ? {} : { model: entry.model as string }),
      ...(entry.effort === undefined ? {} : { effort: entry.effort as WorkProfile['effort'] }),
      ...(entry.subagentModel === undefined ? {} : { subagentModel: entry.subagentModel as string }),
      ...(entry.skill === undefined ? {} : { skill: entry.skill as string }),
    });
  }
  return profiles;
}

/** New session's Profile picker's choice once the model or effort no longer match the profile picked. */
export const CUSTOM_PROFILE_TEXT = 'Custom';

/** New session's Profile picker's choice for no profile (W155; Phil, 2026-11-09). */
export const NO_PROFILE_TEXT = `${NO_PROFILE} (pitwall's defaults)`;

/**
 * The line under New session's Profile picker on None: no profile, so the model and effort are
 * pitwall's defaults for sessions, and its sub-agents pitwall's default for them, or Claude Code's.
 */
export function noProfileHint(work: WorkSettings | undefined): string {
  const sub = work?.effective.subagents.model;
  const subagents =
    work === undefined
      ? "Sub-agents on pitwall's default for them."
      : sub === undefined || sub === WORK_DEFAULT
        ? "Sub-agents on Claude Code's default."
        : `Sub-agents on pitwall's default for them, ${sub}.`;
  return `No profile: pitwall's defaults for sessions, as Preferences sets them. ${subagents}`;
}

/**
 * The line under New session's Profile picker (W155): what the profile adds besides the model and
 * effort, its sub-agents' default model and its skill, and, once you've changed the model or effort,
 * that those still come from it.
 */
export function profileHint(profile: WorkProfile, custom: boolean): string {
  const sub =
    profile.subagentModel === undefined
      ? "Sub-agents on pitwall's default for them."
      : profile.subagentModel === WORK_DEFAULT
        ? "Sub-agents on Claude Code's default."
        : `Sub-agents default to ${profile.subagentModel}.`;
  const skill = profile.skill === undefined ? '' : ` Starts with /${profile.skill}, which must be installed where the session runs.`;
  const prefix = custom ? `${CUSTOM_PROFILE_TEXT}: your model and effort, with the ${profile.name} profile's sub-agents${profile.skill === undefined ? '' : ' and skill'}. ` : '';
  return `${prefix}${sub}${skill}`;
}

const SCOPES: readonly string[] = ['managed', 'local', 'project', 'user'];
const SETTING_KEYS: readonly string[] = ['model', 'effortLevel', 'modelSettings', 'maxEffortLevel'];
/** The variables a source may name (W122): only these are shown. */
const VARIABLES: readonly string[] = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];

function readSource(value: unknown): ClaudeDefaultSource | undefined {
  if (!isRecord(value)) return undefined;
  const scope = typeof value.scope === 'string' && SCOPES.includes(value.scope) ? (value.scope as ClaudeSettingsScope) : undefined;
  switch (value.kind) {
    case 'variable':
      if (typeof value.name !== 'string' || !VARIABLES.includes(value.name)) return undefined;
      return { kind: 'variable', name: value.name, ...(scope === undefined ? {} : { scope }) };
    case 'setting':
      if (typeof value.key !== 'string' || !SETTING_KEYS.includes(value.key) || scope === undefined) return undefined;
      return { kind: 'setting', key: value.key as 'model', scope };
    case 'model':
    case 'account':
    case 'session':
      return { kind: value.kind };
    default:
      return undefined;
  }
}

/**
 * One default, read defensively: a source pitwall knows, and a value only where the same check as the
 * server's passes (W122's review): a model isWorkModel() allows for the kind, an effort one of Claude
 * Code's levels, `auto` or `none`. A project's settings file comes with a clone, so a default could
 * otherwise be any text, such as a command dressed as advice.
 */
function readDefault(value: unknown, field: 'model' | 'effort', kind: WorkKind): ClaudeDefault | undefined {
  if (!isRecord(value)) return undefined;
  const source = readSource(value.source);
  if (source === undefined) return undefined;
  const note: Pick<ClaudeDefault, 'note'> = value.note === 'unrecognised' || value.note === 'may-not-apply' ? { note: value.note } : {};
  if (value.value === undefined) return { source, ...note };
  const allowed = field === 'model' ? isWorkModel(value.value, kind) : isEffortLevel(value.value) || value.value === 'auto' || value.value === 'none';
  if (!allowed) return undefined;
  return { value: value.value as string, source, ...note };
}

function readClaudeDefaults(value: unknown): ClaudeDefaults | undefined {
  if (!isRecord(value) || !isRecord(value.model) || !isRecord(value.effort)) return undefined;
  const model = {} as ClaudeDefaults['model'];
  const effort = {} as ClaudeDefaults['effort'];
  for (const kind of WORK_KINDS) {
    const one = readDefault(value.model[kind], 'model', kind);
    if (one === undefined) return undefined;
    model[kind] = one;
    effort[kind] = {};
    const byModel = value.effort[kind];
    if (!isRecord(byModel)) continue;
    for (const [name, entry] of Object.entries(byModel)) {
      const read = readDefault(entry, 'effort', kind);
      if (read !== undefined && name.length <= 64) effort[kind][name] = read;
    }
  }
  return { model, effort, ...(typeof value.dir === 'string' ? { dir: value.dir } : {}) };
}

/** GET WORK_PATH, with New session's directory (W122) for its project settings. */
export async function fetchWorkSettings(api: Pick<ApiClient, 'get'>, signal?: AbortSignal, dir?: string): Promise<WorkSettings | undefined> {
  const where = dir === undefined || dir === '' ? WORK_PATH : `${WORK_PATH}?dir=${encodeURIComponent(dir)}`;
  const result = await api.get(where, signal === undefined ? {} : { signal });
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

/** A model as people say it: `claude-opus-5-5` as Opus 5.5, `claude-haiku-4-5-20251001` as Haiku 4.5; an alias as itself. */
export function modelText(model: string): string {
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i.exec(model);
  if (!match) return model;
  const family = match[1]!.toLowerCase();
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${match[2]}${match[3] === undefined ? '' : `.${match[3]}`}${match[4] === undefined ? '' : ' (1M)'}`;
}

/** A field's value as shown: a model by modelText(), an effort as itself, the field's label saying what it is. */
function fieldValueText(field: 'model' | 'effort', value: string): string {
  return field === 'model' ? modelText(value) : value;
}

/** Where a settings file is, in words. */
export const SCOPE_TEXT: Readonly<Record<ClaudeSettingsScope, string>> = {
  user: 'your Claude Code settings',
  project: "the project's Claude Code settings",
  local: "the project's local Claude Code settings",
  managed: "your organization's managed settings",
};

/** Where a Claude Code default comes from, in the brackets after it. */
export function sourceText(source: ClaudeDefaultSource): string {
  switch (source.kind) {
    case 'variable':
      return source.scope === undefined ? source.name : `${source.name} in ${SCOPE_TEXT[source.scope]}`;
    case 'setting':
      return source.key === 'maxEffortLevel' ? `the maxEffortLevel cap in ${SCOPE_TEXT[source.scope]}` : SCOPE_TEXT[source.scope];
    case 'model':
      return "the model's own";
    case 'account':
      return 'your Claude account';
    case 'session':
      return "the session's";
  }
}

/** Claude Code's default, resolved, as words after "Default: ": "Opus 5.5 (your Claude Code settings)". */
export function claudeText(field: 'model' | 'effort', resolved: ClaudeDefault): string {
  const { value, source } = resolved;
  if (source.kind === 'account') return field === 'effort' ? "set by your Claude account's model" : 'set by your Claude account';
  if (source.kind === 'session') return "the session's model";
  if (resolved.note === 'unrecognised') return `a model pitwall doesn't recognise (${sourceText(source)})`;
  if (value === undefined) return field === 'effort' ? "the model's own" : CLAUDE_DEFAULT_TEXT;
  if (resolved.note === 'may-not-apply') return `${fieldValueText(field, value)} (${sourceText(source)}, may not apply to this model)`;
  if (field === 'effort' && value === 'auto') return `none sent, the API's own (${sourceText(source)})`;
  if (field === 'effort' && value === 'none') return 'none (the model takes none)';
  return `${fieldValueText(field, value)} (${sourceText(source)})`;
}

/**
 * Claude Code's default for `kind`'s `field`, from the server's `claude` (W122), or undefined when it
 * didn't send one. For effort, on `model`: the model the kind would run on, WORK_DEFAULT or none for
 * Claude Code's own.
 */
export function claudeDefault(settings: WorkSettings, kind: WorkKind, field: 'model' | 'effort', model?: string): ClaudeDefault | undefined {
  const claude = settings.claude;
  if (claude === undefined) return undefined;
  if (field === 'model') return claude.model[kind];
  return claude.effort[kind][model === undefined ? WORK_DEFAULT : model];
}

/** The model `kind` runs on as things stand: the override, else the config file's, else pitwall's; WORK_DEFAULT for Claude Code's. */
export function modelInEffect(settings: WorkSettings, kind: WorkKind): string {
  return settings.effective[kind].model ?? WORK_DEFAULT;
}

/** What applies without an override, and where it comes from: the config file, or pitwall's own. */
export function defaultOf(settings: WorkSettings, kind: WorkKind, field: 'model' | 'effort'): { value?: string; source: 'config' | 'pitwall' } {
  const config = settings.config[kind][field];
  if (config !== undefined) return { value: config, source: 'config' };
  const builtIn = settings.builtIn[kind][field];
  return builtIn === undefined ? { source: 'pitwall' } : { value: builtIn, source: 'pitwall' };
}

/** "Default: " and Claude Code's default, resolved where the server said, else "Claude Code's". */
function claudeDefaultText(settings: WorkSettings, kind: WorkKind, field: 'model' | 'effort', model?: string): string {
  const resolved = claudeDefault(settings, kind, field, model);
  return resolved === undefined ? "Default: Claude Code's" : `Default: ${claudeText(field, resolved)}`;
}

/**
 * Preferences' first option, with no override: "Default: opus (the config file)", "Default: Haiku 5.5
 * (pitwall's default)", or Claude Code's, resolved (W122): "Default: Opus 5.5 (your Claude Code
 * settings)", "Default: medium (the model's own)". An effort's is on the model in effect.
 */
export function defaultText(settings: WorkSettings, kind: WorkKind, field: 'model' | 'effort'): string {
  const { value, source } = defaultOf(settings, kind, field);
  if (value === undefined || value === WORK_DEFAULT) return claudeDefaultText(settings, kind, field, field === 'effort' ? modelInEffect(settings, kind) : undefined);
  return `Default: ${fieldValueText(field, value)} (${source === 'config' ? 'the config file' : "pitwall's default"})`;
}

/**
 * New session's first option: what the server applies to a session with none chosen, the override
 * included, so "Default: opus" or Claude Code's, resolved for the directory. "Default" before the
 * settings load. An effort's is on `model`, the Model field's choice, or the default's.
 */
export function sessionDefaultText(settings: WorkSettings | undefined, field: 'model' | 'effort', model?: string): string {
  if (settings === undefined) return 'Default';
  const value = settings.effective.session[field];
  if (value !== undefined && value !== WORK_DEFAULT) return `Default: ${fieldValueText(field, value)}`;
  return claudeDefaultText(settings, 'session', field, field === 'effort' ? (model ?? modelInEffect(settings, 'session')) : undefined);
}

/** The "Claude Code's default" option, with its value where the server resolved it: "Claude Code's default: Opus 5.5 (…)". */
export function claudeChoiceText(settings: WorkSettings | undefined, kind: WorkKind, field: 'model' | 'effort', model?: string): string {
  const resolved = settings === undefined ? undefined : claudeDefault(settings, kind, field, model);
  return resolved === undefined ? CLAUDE_DEFAULT_TEXT : `${CLAUDE_DEFAULT_TEXT}: ${claudeText(field, resolved)}`;
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

/**
 * An option's words for a value from choiceValues(): Claude Code's default with its value where
 * known, a model by modelText(), an effort as itself. For effort, on the model in effect.
 */
export function choiceText(value: string, settings?: WorkSettings, kind?: WorkKind, field: 'model' | 'effort' = 'model'): string {
  if (value === WORK_DEFAULT) return settings === undefined || kind === undefined ? CLAUDE_DEFAULT_TEXT : claudeChoiceText(settings, kind, field, field === 'effort' ? modelInEffect(settings, kind) : undefined);
  return field === 'model' ? modelText(value) : value;
}

/**
 * What a kind of work has cost, at API list prices, as `claude -p` reports them, for Preferences:
 * "$0.04", "under $0.01", or undefined when there's nothing to say.
 */
export function usdText(costUsd: number | undefined): string | undefined {
  if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0) return undefined;
  return costUsd < 0.005 ? 'under $0.01' : `$${costUsd.toFixed(2)}`;
}
