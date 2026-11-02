// W119: Preferences' Models and effort section and New session's Model and Effort fields, against a
// fake server. Made-up values only.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SPAWN_PATH, WORK_PATH, type IndexSnapshot, type WorkSettings } from '../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from './api.js';
import { NewSessionDialog } from './components/NewSessionDialog.js';
import { recapCostText, supervisorCostText, WorkPreferences } from './components/Preferences.js';
import { choiceValues, defaultText, readWorkSettings, usdText, withOverride } from './modelEffort.js';
import { group, session, snapshot } from './test/fixtures.js';

const API_KEY = 'k'.repeat(43);
const REPO = '/Users/example/code/demo-app';

const empty = () => ({ session: {}, subagents: {}, supervisor: {}, recaps: {}, relay: {} });

function settings(overrides: Partial<WorkSettings> = {}): WorkSettings {
  const builtIn = { ...empty(), supervisor: { model: 'claude-opus-5-5' }, recaps: { model: 'claude-haiku-5-5' }, relay: { model: 'haiku' } };
  const config = { ...empty(), session: { model: 'opus', effort: 'high' as const }, subagents: { model: 'haiku' } };
  return {
    builtIn,
    config,
    overrides: empty(),
    effective: { ...builtIn, session: { model: 'opus', effort: 'high' }, subagents: { model: 'haiku' } },
    configFile: '/Users/example/.pitwall/config.json',
    ...overrides,
  };
}

const settle = () => act(async () => {});

/** A fake server: GET WORK_PATH answers `initial`; POST WORK_PATH `post`'s answer; POST SPAWN_PATH 201. */
function fakeServer(initial: WorkSettings, post: (body: unknown) => { status: number; body: unknown } = (body) => ({ status: 200, body: { ...initial, overrides: (body as { overrides: unknown }).overrides } })) {
  return vi.fn<FetchLike>(async (url, init) => {
    if (url.endsWith(WORK_PATH) && init.method === undefined) return new Response(JSON.stringify(initial), { status: 200 });
    if (url.endsWith(WORK_PATH) && init.method === 'POST') {
      const answer = post(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    if (url.endsWith(SPAWN_PATH)) return new Response(JSON.stringify({ ok: true, shortId: 'c0ffee12', name: 'pitwall-test-spawn' }), { status: 201 });
    return new Response('{}', { status: 404 });
  });
}

const posts = (fetch: ReturnType<typeof fakeServer>, path: string) =>
  fetch.mock.calls.filter(([url, init]) => url.endsWith(path) && init.method === 'POST').map(([, init]) => JSON.parse(String(init.body)) as unknown);

function renderSection(fetch: FetchLike, props: Parameters<typeof WorkPreferences>[0] = {}) {
  const api = createApiClient({ apiKey: API_KEY, fetch });
  return render(
    <ApiContext.Provider value={api}>
      <WorkPreferences {...props} />
    </ApiContext.Provider>,
  );
}

const rowOf = (name: string) => screen.getByRole('group', { name });
const selectIn = (row: HTMLElement, label: 'Model' | 'Effort') => within(row).getByLabelText(label) as HTMLSelectElement;
const optionTexts = (select: HTMLSelectElement) => [...select.options].map((option) => option.textContent);

describe('the words and choices', () => {
  it('names the default and where it comes from', () => {
    const s = settings();
    expect(defaultText(s, 'session', 'model')).toBe('Default: opus, from the config file');
    expect(defaultText(s, 'recaps', 'model')).toBe('Default: claude-haiku-5-5');
    expect(defaultText(s, 'recaps', 'effort')).toBe("Default: Claude Code's");
    expect(defaultText({ ...s, config: { ...s.config, relay: { model: 'default' } } }, 'relay', 'model')).toBe("Default: Claude Code's, from the config file");
  });

  it("offers Claude Code's default only when the default isn't already it, sub-agents' four aliases, and any full name a layer names", () => {
    const s = settings();
    expect(choiceValues(s, 'recaps', 'model')).toEqual(['default', 'opus', 'sonnet', 'haiku', 'fable', 'claude-haiku-5-5']);
    expect(choiceValues(s, 'subagents', 'model')).toEqual(['default', 'opus', 'sonnet', 'haiku', 'fable']);
    expect(choiceValues(s, 'recaps', 'effort')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(choiceValues(s, 'session', 'effort')).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('sets and clears one field of one kind, in a new object', () => {
    const before = empty();
    const after = withOverride(before, 'recaps', 'effort', 'low');
    expect(after.recaps).toEqual({ effort: 'low' });
    expect(before.recaps).toEqual({});
    expect(withOverride(after, 'recaps', 'effort', '').recaps).toEqual({});
  });

  it("reads the server's answer defensively: a value pitwall doesn't allow is dropped", () => {
    const read = readWorkSettings({ ...settings(), overrides: { ...empty(), session: { model: 'opus --x', effort: 'ultracode' }, subagents: { effort: 'low' } } });
    expect(read?.overrides.session).toEqual({});
    expect(read?.overrides.subagents).toEqual({});
    expect(readWorkSettings({ builtIn: {} })).toBeUndefined();
  });

  it('says what recaps and the supervisor have cost', () => {
    expect(recapCostText({ calls: 37, budget: 200, costUsd: 0.0412 })).toBe('Today: $0.04 for 37 of 200 calls, at API list prices.');
    expect(recapCostText({ calls: 1, budget: 200, costUsd: 0.001 })).toBe('Today: under $0.01 for 1 of 200 calls, at API list prices.');
    expect(recapCostText(undefined)).toBe('Recaps are off for this run (--no-recaps).');
    expect(supervisorCostText({ status: 'idle', approvals: [], costUsd: 0.123 })).toBe('This run: $0.12, at API list prices.');
    expect(supervisorCostText({ status: 'off', approvals: [] })).toBe('This run: nothing yet.');
    expect(supervisorCostText(undefined)).toBe('The supervisor is off for this run (--no-supervisor).');
    expect(usdText(-1)).toBeUndefined();
  });
});

describe("Preferences' Models and effort", () => {
  it('shows a Model and an Effort for each kind, sub-agents a Model only, each starting from its default, with the costs', async () => {
    const fetch = fakeServer(settings());
    renderSection(fetch, { recaps: { calls: 37, budget: 200, costUsd: 0.04 }, supervisor: { status: 'idle', approvals: [], costUsd: 0.12 } });
    expect(screen.getByText('Loading the models…')).toBeTruthy();
    await settle();
    expect(screen.getByText(/pitwall's server keeps these until it stops. They don't change the config file/)).toBeTruthy();
    for (const name of ['Sessions', 'Supervisor', 'Recaps', 'Relay']) {
      expect(selectIn(rowOf(name), 'Model').value, name).toBe('');
      expect(selectIn(rowOf(name), 'Effort').value, name).toBe('');
    }
    expect(within(rowOf("Sessions' sub-agents")).queryByLabelText('Effort')).toBeNull();
    expect(within(rowOf("Sessions' sub-agents")).getByText(/Claude Code has no separate setting for it/)).toBeTruthy();
    expect(optionTexts(selectIn(rowOf('Sessions'), 'Model'))[0]).toBe('Default: opus, from the config file');
    expect(optionTexts(selectIn(rowOf('Recaps'), 'Model'))).toEqual(['Default: claude-haiku-5-5', "Claude Code's default", 'opus', 'sonnet', 'haiku', 'fable', 'claude-haiku-5-5']);
    expect(within(rowOf('Recaps')).getByText(/Today: \$0\.04 for 37 of 200 calls/)).toBeTruthy();
    expect(within(rowOf('Supervisor')).getByText(/This run: \$0\.12/)).toBeTruthy();
  });

  it('sends the whole set of overrides at once for each change, and keeps what the server answers', async () => {
    const fetch = fakeServer(settings());
    renderSection(fetch);
    await settle();
    fireEvent.change(selectIn(rowOf('Recaps'), 'Effort'), { target: { value: 'low' } });
    fireEvent.change(selectIn(rowOf('Supervisor'), 'Model'), { target: { value: 'sonnet' } });
    await settle();
    expect(posts(fetch, WORK_PATH)).toEqual([
      { overrides: { ...empty(), recaps: { effort: 'low' } } },
      { overrides: { ...empty(), recaps: { effort: 'low' }, supervisor: { model: 'sonnet' } } },
    ]);
    expect(selectIn(rowOf('Recaps'), 'Effort').value).toBe('low');
    expect(selectIn(rowOf('Supervisor'), 'Model').value).toBe('sonnet');
    // Back to the default: the field leaves the overrides.
    fireEvent.change(selectIn(rowOf('Recaps'), 'Effort'), { target: { value: '' } });
    await settle();
    expect(posts(fetch, WORK_PATH).at(-1)).toEqual({ overrides: { ...empty(), supervisor: { model: 'sonnet' } } });
  });

  it("puts the choice back and says why when the server refuses it", async () => {
    const fetch = fakeServer(settings(), () => ({ status: 400, body: { error: '"overrides.relay.model" must be a Claude Code model.' } }));
    renderSection(fetch);
    await settle();
    fireEvent.change(selectIn(rowOf('Relay'), 'Model'), { target: { value: 'opus' } });
    await settle();
    expect(selectIn(rowOf('Relay'), 'Model').value).toBe('');
    expect(screen.getByRole('alert').textContent).toContain('"overrides.relay.model" must be a Claude Code model.');
  });

  it("says it couldn't load them when the server doesn't answer with settings", async () => {
    renderSection(vi.fn<FetchLike>(async () => new Response('{}', { status: 500 })));
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(/couldn't load the models and effort/);
    expect(screen.queryByRole('group')).toBeNull();
  });
});

describe("New session's Model and Effort (W119)", () => {
  const snap = (): IndexSnapshot => snapshot([group({ key: REPO, label: 'demo-app', sessions: [session({ name: 'demo-docs', cwd: REPO })] })]);

  function renderDialog(fetch: FetchLike) {
    const api = createApiClient({ apiKey: API_KEY, fetch });
    return render(
      <ApiContext.Provider value={api}>
        <NewSessionDialog snapshot={snap()} onClose={() => {}} onStarted={() => {}} />
      </ApiContext.Provider>,
    );
  }

  it('starts from the defaults for sessions, which its first options name, and sends nothing for them', async () => {
    const fetch = fakeServer(settings());
    renderDialog(fetch);
    await settle();
    const model = screen.getByLabelText(/^Model/) as HTMLSelectElement;
    const effort = screen.getByLabelText(/^Effort/) as HTMLSelectElement;
    expect([model.value, effort.value]).toEqual(['', '']);
    expect(optionTexts(model).slice(0, 2)).toEqual(['Default: opus', "Claude Code's default"]);
    expect(optionTexts(effort)).toEqual(['Default: high', "Claude Code's default", 'low', 'medium', 'high', 'xhigh', 'max']);
    fireEvent.change(screen.getByLabelText('First prompt'), { target: { value: 'go' } });
    fireEvent.submit(document.querySelector('form')!);
    await settle();
    expect(posts(fetch, SPAWN_PATH)).toEqual([{ cwd: REPO, prompt: 'go' }]);
  });

  it("sends the effort chosen, and Claude Code's default as default", async () => {
    const fetch = fakeServer(settings());
    renderDialog(fetch);
    await settle();
    fireEvent.change(screen.getByLabelText(/^Model/), { target: { value: 'default' } });
    fireEvent.change(screen.getByLabelText(/^Effort/), { target: { value: 'xhigh' } });
    fireEvent.change(screen.getByLabelText('First prompt'), { target: { value: 'go' } });
    fireEvent.submit(document.querySelector('form')!);
    await settle();
    expect(posts(fetch, SPAWN_PATH)).toEqual([{ cwd: REPO, prompt: 'go', model: 'default', effort: 'xhigh' }]);
  });

  it('says Default, with no Claude Code default to choose, when there are no defaults for sessions or they fail to load', async () => {
    renderDialog(vi.fn<FetchLike>(async () => new Response('{}', { status: 500 })));
    await settle();
    expect(optionTexts(screen.getByLabelText(/^Effort/) as HTMLSelectElement)).toEqual(['Default', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(optionTexts(screen.getByLabelText(/^Model/) as HTMLSelectElement)[1]).toBe('sonnet');
  });
});
