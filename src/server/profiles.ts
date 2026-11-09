// Work profiles (W155, extends W119): a session's launch settings, by name. Each is a model, an effort,
// the sub-agents' default model and an optional skill the session starts with. pitwall has four of
// its own; the config file's `profiles` adds more, and one with a built-in's name replaces it.
//
//   "profiles": {
//     "Review": { "model": "sonnet", "effort": "high", "subagentModel": "sonnet", "skill": "agent-roles:role-reviewer" }
//   }
//
// What reaches the command line, and how (actions.ts):
// - `model` and `effort` are checked as W119's `work.session` is, and passed as `--model` and
//   `--effort` (workArgs()).
// - `subagentModel` is CLAUDE_CODE_SUBAGENT_MODEL on the session's environment, a default only: since
//   Claude Code v2.1.251 an Agent call's own `model`, or a sub-agent definition's, beats it, and pitwall
//   never sets CLAUDE_CODE_SUBAGENT_MODEL_FORCE (Phil, 2026-11-06), so a security review on Opus or a
//   plugin's Haiku agent keeps its model.
// - `skill` is a name, SKILL_NAME_PATTERN, never free text: the first prompt becomes
//   `/<skill> <prompt>`, after `--`, so it's the prompt, never an option. W155's check (PLAN.md): a
//   project skill and a plugin's `plugin:skill` named at the start of `claude --bg`'s prompt run as
//   they do typed. A skill Claude Code doesn't find where the session runs is "Unknown command", and
//   the prompt never reaches the model: the session waits for you.
// - The server resolves a request's profile by its name from these, never from what the page sends
//   beyond the name. pitwall keeps no prompts of its own: the instructions stay in skills.
import {
  DEFAULT_PROFILE,
  isEffortLevel,
  isSkillName,
  isWorkModel,
  SUPERVISOR_MODEL,
  WORK_DEFAULT,
  WORK_PROFILE_NAME_PATTERN,
  WORK_PROFILES_MAX,
  type WorkProfile,
} from '../shared/protocol.js';
import { EFFORT_PROBLEM, modelProblem } from './work.js';

/** Opus 5.5, by its full name, as the supervisor's: an alias would follow the next Opus. */
const OPUS = SUPERVISOR_MODEL;

/** pitwall's own profiles (Phil, 2026-11-06), in the order New session lists them. */
export const BUILT_IN_PROFILES: readonly Readonly<WorkProfile>[] = Object.freeze([
  Object.freeze({ name: DEFAULT_PROFILE, model: OPUS, effort: 'high', subagentModel: 'sonnet', source: 'built-in' }),
  Object.freeze({ name: 'Review', model: 'sonnet', effort: 'high', subagentModel: 'sonnet', source: 'built-in' }),
  Object.freeze({ name: 'Security review', model: OPUS, effort: 'xhigh', subagentModel: 'opus', source: 'built-in' }),
  Object.freeze({ name: 'Docs', model: 'sonnet', effort: 'medium', subagentModel: 'sonnet', source: 'built-in' }),
] satisfies WorkProfile[]);

/** The words for a bad skill name, after its key. Never the value itself (D24). */
export const SKILL_PROBLEM =
  'must be a skill\'s name without its "/": letters, digits and hyphens, with one optional "plugin:" part, such as "agent-roles:role-reviewer"';

const PROFILE_NAME_PROBLEM = `must be 1 to 40 letters, digits, spaces, ".", "_" and "-", starting with a letter or digit`;

/** The name New session's picker shows once the model or effort changes: never a profile's. */
const RESERVED_NAMES = new Set(['custom']);

/**
 * The config file's `profiles`, checked: an object whose keys are the names and whose values are
 * `{ model?, effort?, subagentModel?, skill? }`. `fail` throws; `unknown` is told of each key it
 * doesn't know. Never quotes a value, only keys, and a key that isn't a valid name is said by its place.
 */
export function parseProfiles(
  value: unknown,
  key: string,
  fail: (key: string, message: string) => never,
  unknown: (key: string) => void,
): WorkProfile[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(key, 'must be an object of profiles by name, such as { "Review": { "model": "sonnet", "effort": "high" } }');
  }
  const names = Object.keys(value);
  if (names.length > WORK_PROFILES_MAX) return fail(key, `can name at most ${WORK_PROFILES_MAX} profiles`);
  const seen = new Set<string>();
  const profiles: WorkProfile[] = [];
  names.forEach((name, i) => {
    if (!WORK_PROFILE_NAME_PATTERN.test(name)) fail(`${key}, its profile number ${i + 1}`, `has a name that ${PROFILE_NAME_PROBLEM}`);
    const where = `${key}.${name}`;
    const folded = name.toLowerCase();
    if (RESERVED_NAMES.has(folded)) fail(where, 'is a name New session uses for a model or effort that no profile has. Choose another.');
    if (seen.has(folded)) fail(where, 'has the same name as another profile, ignoring case. Name each once.');
    seen.add(folded);
    profiles.push(parseProfile(name, (value as Record<string, unknown>)[name], where, fail, unknown));
  });
  return profiles;
}

function parseProfile(
  name: string,
  value: unknown,
  key: string,
  fail: (key: string, message: string) => never,
  unknown: (key: string) => void,
): WorkProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(key, 'must be an object, such as { "model": "sonnet", "effort": "high", "subagentModel": "sonnet" }');
  }
  const entry = value as Record<string, unknown>;
  for (const field of Object.keys(entry)) if (!['model', 'effort', 'subagentModel', 'skill'].includes(field)) unknown(`${key}.${field}`);
  const profile: WorkProfile = { name, source: 'config' };
  if (Object.hasOwn(entry, 'model')) {
    if (entry.model !== WORK_DEFAULT && !isWorkModel(entry.model, 'session')) return fail(`${key}.model`, modelProblem('session'));
    profile.model = entry.model;
  }
  if (Object.hasOwn(entry, 'effort')) {
    if (entry.effort !== WORK_DEFAULT && !isEffortLevel(entry.effort)) return fail(`${key}.effort`, EFFORT_PROBLEM);
    profile.effort = entry.effort;
  }
  if (Object.hasOwn(entry, 'subagentModel')) {
    if (entry.subagentModel !== WORK_DEFAULT && !isWorkModel(entry.subagentModel, 'subagents')) return fail(`${key}.subagentModel`, modelProblem('subagents'));
    profile.subagentModel = entry.subagentModel;
  }
  if (Object.hasOwn(entry, 'skill')) {
    if (!isSkillName(entry.skill)) return fail(`${key}.skill`, SKILL_PROBLEM);
    profile.skill = entry.skill;
  }
  return profile;
}

/**
 * The profiles that apply: the built-ins, each replaced in place by the config file's of the same
 * name, ignoring case, then the config file's others, in its order. New objects.
 */
export function mergeProfiles(config: readonly WorkProfile[] = []): WorkProfile[] {
  const byName = new Map(config.map((profile) => [profile.name.toLowerCase(), profile]));
  // A replacement keeps the built-in's own name, so `build` replaces Build and Build is still found by name.
  const merged = BUILT_IN_PROFILES.map((builtIn) => {
    const replacement = byName.get(builtIn.name.toLowerCase());
    return replacement === undefined ? { ...builtIn } : { ...replacement, name: builtIn.name };
  });
  const builtInNames = new Set(BUILT_IN_PROFILES.map((profile) => profile.name.toLowerCase()));
  for (const profile of config) if (!builtInNames.has(profile.name.toLowerCase())) merged.push({ ...profile });
  return merged;
}

/** The first prompt with the profile's skill before it, as typed: `/<skill> <prompt>`. Unchanged without one. */
export function withSkill(prompt: string, skill: string | undefined): string {
  if (skill === undefined) return prompt;
  // Checked again here, at the last step before the command line: a name, or nothing.
  if (!isSkillName(skill)) throw new Error('A profile skill failed SKILL_NAME_PATTERN.');
  return `/${skill} ${prompt}`;
}
