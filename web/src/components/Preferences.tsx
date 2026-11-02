// The Preferences dialog (docs/design-system.md, 4: Preferences), W59, in place of W42's View
// preferences menu. Phil, 2026-10-23: "the preferences pane should be a dialog with sections covering
// the area that's being configured." The header's `preferences` icon button opens it.
//
// A Dialog, with no footer: each choice applies as it's made, as the menu's did, and the page behind
// shows it at once, so there's nothing to save or cancel. Its sections follow the page, left to right:
//
// - Repo list: Group sessions by (W42), which decides the repo list's groups and their counts.
// - Session view: Open running background sessions on (W54), and The terminal takes the keyboard (W57).
// - Models and effort (W119): the model and effort for each kind of work pitwall starts, a Model and
//   an Effort select for each, the first option the default and where it's from, Claude Code's own
//   resolved from its settings and environment by the server (W122), and what recaps and
//   the supervisor have cost, so a choice rests on numbers. Unlike the others, these are kept by
//   pitwall's server for its run, never in the browser, and never written to the config file. A
//   change is sent at once; a refusal is an inline alert, and the choice goes back.
//
// The settings that have buttons of their own aren't repeated here (W62; Phil, 2026-10-23: "I don't
// think we should duplicate settings that already have their own standalone buttons"): the single-key
// shortcuts are the keyboard shortcuts dialog's off switch, and the theme is the header's switch.
//
// The large dialog, 840 px (W122), so a kind of work, its model and its effort share a line, with
// Claude Code's resolved defaults in full, and from 900 px never over the repo list (W62,
// Preferences.css). Each section is a <section> named by
// its <h3>, and each setting a RadioGroup.
// Sort stays in the session list's header and the view's width on the divider: both are view
// controls, used in place. Each setting keeps its own key and validation, the Dashboard's, passed in.

import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { WORK_KINDS, type IndexSnapshot, type WorkChoices, type WorkKind, type WorkSettings } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import {
  choiceText,
  choiceValues,
  CLAUDE_DEFAULTS_TEXT,
  defaultText,
  fetchWorkSettings,
  saveWorkOverrides,
  usdText,
  withOverride,
  WORK_HINTS,
  WORK_LABELS,
  WORK_SECTION_TEXT,
} from '../modelEffort.js';
import { BACKGROUND_TAB_DESCRIPTIONS, BACKGROUND_TAB_LABELS, BACKGROUND_TAB_TITLE, BACKGROUND_TABS, type BackgroundTab } from '../backgroundTab.js';
import { GROUP_BY_DESCRIPTIONS, GROUP_BY_LABELS, GROUP_BY_MODES, GROUP_BY_TITLE, type GroupBy } from '../groupBy.js';
import { TERMINAL_FOCUS_DESCRIPTIONS, TERMINAL_FOCUS_LABELS, TERMINAL_FOCUS_TITLE, TERMINAL_FOCUSES, type TerminalFocus } from '../terminalFocus.js';
import { Alert } from './Alert.js';
import { Dialog } from './Dialog.js';
import { Icon } from './Icon.js';
import { RadioGroup, type RadioOption } from './RadioGroup.js';
import '../actions.css';
import './Preferences.css';

/** The header button's name and tooltip, and the dialog's title. */
export const PREFERENCES_LABEL = 'Preferences';

/** The dialog's subtitle, which describes it: why there's no Save button, and where the choices are kept. */
export const PREFERENCES_SUBTITLE = 'Each change applies at once. This browser remembers the view settings; pitwall keeps the models for this run.';

/** The sections' titles, in the dialog's order. */
export const PREFERENCE_SECTIONS = {
  repoList: 'Repo list',
  sessionView: 'Session view',
  work: 'Models and effort',
} as const;

const GROUP_BY_OPTIONS: readonly RadioOption<GroupBy>[] = GROUP_BY_MODES.map((mode) => ({ value: mode, label: GROUP_BY_LABELS[mode], description: GROUP_BY_DESCRIPTIONS[mode] }));
const BACKGROUND_TAB_OPTIONS: readonly RadioOption<BackgroundTab>[] = BACKGROUND_TABS.map((tab) => ({ value: tab, label: BACKGROUND_TAB_LABELS[tab], description: BACKGROUND_TAB_DESCRIPTIONS[tab] }));
const TERMINAL_FOCUS_OPTIONS: readonly RadioOption<TerminalFocus>[] = TERMINAL_FOCUSES.map((choice) => ({
  value: choice,
  label: TERMINAL_FOCUS_LABELS[choice],
  description: TERMINAL_FOCUS_DESCRIPTIONS[choice],
}));

/** A section: a <section> named by its <h3>, then its settings. */
function PreferencesSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="preferences-section" aria-labelledby={id}>
      <h3 className="preferences-section-title" id={id}>
        {title}
      </h3>
      {children}
    </section>
  );
}

export interface RepoListPreferencesProps {
  groupBy: GroupBy;
  onGroupBy: (mode: GroupBy) => void;
}

/** Repo list: Group sessions by (W42). */
export function RepoListPreferences({ groupBy, onGroupBy }: RepoListPreferencesProps) {
  return (
    <PreferencesSection title={PREFERENCE_SECTIONS.repoList}>
      <RadioGroup legend={GROUP_BY_TITLE} value={groupBy} options={GROUP_BY_OPTIONS} onChange={onGroupBy} />
    </PreferencesSection>
  );
}

export interface SessionViewPreferencesProps {
  /** The tab a running background session's view opens on (W54). */
  backgroundTab: BackgroundTab;
  onBackgroundTab: (tab: BackgroundTab) => void;
  /** When the terminal takes the keyboard as it attaches (W57). */
  terminalFocus: TerminalFocus;
  onTerminalFocus: (choice: TerminalFocus) => void;
}

/** Session view: Open running background sessions on (W54), and The terminal takes the keyboard (W57). */
export function SessionViewPreferences({ backgroundTab, onBackgroundTab, terminalFocus, onTerminalFocus }: SessionViewPreferencesProps) {
  return (
    <PreferencesSection title={PREFERENCE_SECTIONS.sessionView}>
      <RadioGroup legend={BACKGROUND_TAB_TITLE} value={backgroundTab} options={BACKGROUND_TAB_OPTIONS} onChange={onBackgroundTab} />
      <RadioGroup legend={TERMINAL_FOCUS_TITLE} value={terminalFocus} options={TERMINAL_FOCUS_OPTIONS} onChange={onTerminalFocus} />
    </PreferencesSection>
  );
}

/** What the Models and effort section says while it loads, when it can't, and of the costs. */
export const WORK_TEXT = {
  loading: 'Loading the models…',
  failed: "pitwall couldn't load the models and effort. Close Preferences and open it again to retry.",
  noApi: "They can't be changed from here.",
  recapsOff: 'Recaps are off for this run (--no-recaps).',
  supervisorOff: 'The supervisor is off for this run (--no-supervisor).',
} as const;

/** "Today: $0.04 for 37 of 200 calls", from the snapshot's recaps. */
export function recapCostText(health: IndexSnapshot['recaps']): string {
  if (health === undefined) return WORK_TEXT.recapsOff;
  const calls = `${health.calls} of ${health.budget} ${health.budget === 1 ? 'call' : 'calls'}`;
  return `Today: ${usdText(health.costUsd) ?? '$0.00'} for ${calls}, at API list prices.`;
}

/** "This run: $0.12", from the snapshot's supervisor. */
export function supervisorCostText(state: IndexSnapshot['supervisor']): string {
  if (state === undefined) return WORK_TEXT.supervisorOff;
  const cost = usdText(state.costUsd);
  return cost === undefined ? 'This run: nothing yet.' : `This run: ${cost}, at API list prices.`;
}

export interface WorkPreferencesProps {
  /** The snapshot's recap health and supervisor state, for what each has cost. */
  recaps?: IndexSnapshot['recaps'];
  supervisor?: IndexSnapshot['supervisor'];
  /** For the gallery: settings to start from, without the API. */
  initial?: WorkSettings;
}

/** One kind's Model and Effort selects, with the default first. Sub-agents have Model only. */
function WorkRow({ kind, settings, onChange, cost }: { kind: WorkKind; settings: WorkSettings; onChange: (kind: WorkKind, field: 'model' | 'effort', value: string) => void; cost?: string }) {
  const id = useId();
  const fields = kind === 'subagents' ? (['model'] as const) : (['model', 'effort'] as const);
  return (
    <div className="work-row" role="group" aria-labelledby={`${id}-name`} aria-describedby={`${id}-hint`}>
      <p className="work-row-name" id={`${id}-name`}>
        {WORK_LABELS[kind]}
      </p>
      <p className="field-hint work-row-hint" id={`${id}-hint`}>
        {WORK_HINTS[kind]}
        {cost !== undefined && <span className="work-row-cost"> {cost}</span>}
      </p>
      <div className="work-row-fields">
        {fields.map((field) => (
          <div className="field" key={field}>
            <label className="field-label" htmlFor={`${id}-${field}`}>
              {field === 'model' ? 'Model' : 'Effort'}
            </label>
            <span className="select">
              <select
                id={`${id}-${field}`}
                className="select-input"
                value={settings.overrides[kind][field] ?? ''}
                onChange={(event) => onChange(kind, field, event.currentTarget.value)}
              >
                <option value="">{defaultText(settings, kind, field)}</option>
                {choiceValues(settings, kind, field).map((value) => (
                  <option key={value} value={value}>
                    {choiceText(value, settings, kind, field)}
                  </option>
                ))}
              </select>
              <Icon name="select" className="select-icon" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Models and effort (W119): each kind of work's model and effort, kept by pitwall's server for this run. */
export function WorkPreferences({ recaps, supervisor, initial }: WorkPreferencesProps) {
  const api = useContext(ApiContext);
  const [settings, setSettings] = useState<WorkSettings | undefined>(initial);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string>();
  // The overrides as last chosen, so two quick changes don't send the first one's stale set.
  const latest = useRef<WorkChoices | undefined>(initial?.overrides);
  // What the server last confirmed, to go back to on a refusal; whether a save is out; and the set to
  // send once it's answered. One save at a time, so the server can't apply them out of order (W119's review).
  const confirmed = useRef<WorkSettings | undefined>(initial);
  const saving = useRef(false);
  const queued = useRef<WorkChoices | undefined>(undefined);

  useEffect(() => {
    if (initial !== undefined) return;
    if (!api) return;
    const controller = new AbortController();
    void fetchWorkSettings(api, controller.signal).then((loaded) => {
      if (controller.signal.aborted) return;
      if (loaded === undefined) setFailed(true);
      else {
        latest.current = loaded.overrides;
        confirmed.current = loaded;
        setSettings(loaded);
      }
    });
    return () => controller.abort();
  }, [api, initial]);

  /** Sends `overrides`, then whatever was chosen while it was out, so the last choice is the last sent. */
  const save = (overrides: WorkChoices) => {
    if (!api) return;
    saving.current = true;
    void saveWorkOverrides(api, overrides).then((outcome) => {
      saving.current = false;
      const next = queued.current;
      queued.current = undefined;
      if (outcome.ok) confirmed.current = outcome.settings;
      // A later choice replaces this one's whole set: send it, and show this answer only if it's the last.
      if (next !== undefined) return save(next);
      if (outcome.ok) {
        latest.current = outcome.settings.overrides;
        setSettings(outcome.settings);
      } else {
        const back = confirmed.current;
        latest.current = back?.overrides;
        setSettings(back);
        setError(outcome.error);
      }
    });
  };

  const change = (kind: WorkKind, field: 'model' | 'effort', value: string) => {
    if (settings === undefined || latest.current === undefined) return;
    const overrides = withOverride(latest.current, kind, field, value);
    latest.current = overrides;
    setSettings({ ...settings, overrides });
    setError(undefined);
    if (saving.current) queued.current = overrides;
    else save(overrides);
  };

  const costs: Partial<Record<WorkKind, string>> = { recaps: recapCostText(recaps), supervisor: supervisorCostText(supervisor) };
  return (
    <PreferencesSection title={PREFERENCE_SECTIONS.work}>
      <p className="field-hint">{WORK_SECTION_TEXT}</p>
      {settings?.claude !== undefined && <p className="field-hint">{CLAUDE_DEFAULTS_TEXT}</p>}
      {settings === undefined && !failed && <p className="field-hint">{api ? WORK_TEXT.loading : WORK_TEXT.noApi}</p>}
      {failed && (
        <Alert tone="danger" role="alert">
          {WORK_TEXT.failed}
        </Alert>
      )}
      {settings !== undefined && WORK_KINDS.map((kind) => <WorkRow key={kind} kind={kind} settings={settings} onChange={change} {...(costs[kind] === undefined ? {} : { cost: costs[kind] })} />)}
      {error !== undefined && (
        <Alert tone="danger" role="alert" onDismiss={() => setError(undefined)}>
          {error}
        </Alert>
      )}
    </PreferencesSection>
  );
}

/** The settings the Dashboard keeps, which the dialog shows and changes. */
export type PreferencesProps = RepoListPreferencesProps & SessionViewPreferencesProps;

export interface PreferencesDialogProps extends PreferencesProps, WorkPreferencesProps {
  onClose: () => void;
}

export function PreferencesDialog({ onClose, groupBy, onGroupBy, backgroundTab, onBackgroundTab, terminalFocus, onTerminalFocus, ...work }: PreferencesDialogProps) {
  return (
    <Dialog title={PREFERENCES_LABEL} subtitle={PREFERENCES_SUBTITLE} size="lg" onClose={onClose} className="preferences-dialog">
      <RepoListPreferences groupBy={groupBy} onGroupBy={onGroupBy} />
      <SessionViewPreferences backgroundTab={backgroundTab} onBackgroundTab={onBackgroundTab} terminalFocus={terminalFocus} onTerminalFocus={onTerminalFocus} />
      <WorkPreferences {...work} />
    </Dialog>
  );
}
