import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SPAWN_PATH, type IndexSnapshot, type SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import type { ConnectionView } from '../connection.js';
import { directoryChoices, directoryProblem, modelProblem, nameProblem, promptProblem } from '../spawn.js';
import { group, NOW, session, snapshot } from '../test/fixtures.js';
import { Dashboard } from './Dashboard.js';

// Made-up sessions and directories only.

const API_KEY = 'k'.repeat(43);
const ROOT = '/Users/example/code';
const REPO = '/Users/example/code/demo-app';
const OTHER_REPO = '/Users/example/code/demo-api';

function snap(sessions: SessionSummary[] = [session({ name: 'demo-docs' })]): IndexSnapshot {
  return snapshot([
    group({ key: REPO, label: 'demo-app', sessions }),
    group({ key: OTHER_REPO, label: 'demo-api', sessions: [session({ name: 'demo-api-work', cwd: OTHER_REPO })] }),
    // A worktree grouped under a main repo outside the root: not offered.
    group({ key: '/srv/elsewhere/repo', label: '/srv/elsewhere/repo', sessions: [session({ name: 'demo-elsewhere', cwd: `${REPO}/wt` })] }),
  ]);
}

type Answer = { status: number; body?: unknown };

/** A fake server: POSTs get the next answer; GETs (the session view's conversation) get an empty page. */
function fakeServer(...answers: Answer[]) {
  let call = 0;
  return vi.fn<FetchLike>(async (url, init) => {
    if (init.method !== 'POST') {
      const sessionId = decodeURIComponent(/\/api\/sessions\/([^/]+)\//.exec(url)?.[1] ?? '');
      return new Response(JSON.stringify({ sessionId, entries: [] }), { status: 200 });
    }
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (!answer) throw new Error('no answer');
    return new Response(answer.body === undefined ? 'not json' : JSON.stringify(answer.body), { status: answer.status });
  });
}

function posts(fetch: ReturnType<typeof fakeServer>) {
  return fetch.mock.calls
    .filter(([, init]) => init.method === 'POST')
    .map(([url, init]) => ({ url, body: JSON.parse(String(init.body)) as unknown, headers: init.headers as Record<string, string> }));
}

function renderDashboard(fetch: FetchLike | undefined, first: IndexSnapshot = snap()) {
  const api = fetch ? createApiClient({ apiKey: API_KEY, fetch }) : undefined;
  const ui = (s: IndexSnapshot) => {
    const view: ConnectionView = { state: 'live', snapshot: s };
    return (
      <ApiContext.Provider value={api}>
        <Dashboard view={view} />
      </ApiContext.Provider>
    );
  };
  const result = render(ui(first));
  return { ...result, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

const settle = () => act(async () => {});

function openDialog(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'New session' }));
  return screen.getByRole('dialog', { name: 'New session' });
}

function fill(dialog: HTMLElement, fields: { prompt?: string; name?: string }) {
  if (fields.prompt !== undefined) fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: fields.prompt } });
  if (fields.name !== undefined) fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: fields.name } });
}

async function submit(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
  await settle();
}

const started = { status: 201, body: { ok: true, shortId: 'c0ffee12', name: 'pitwall-test-spawn' } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

describe('New session: the dialog', () => {
  it('opens from the header, with the directory picker focused, offering the groups under a root, then the roots', () => {
    renderDashboard(fakeServer(started));
    const dialog = openDialog();

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const picker = within(dialog).getByLabelText('Directory') as HTMLSelectElement;
    expect(document.activeElement).toBe(picker);
    expect([...picker.options].map((option) => [option.value, option.textContent])).toEqual([
      [REPO, '~/code/demo-app'],
      [OTHER_REPO, '~/code/demo-api'],
      [ROOT, '~/code'],
      ['\u0000other', 'Another directory under a root…'],
    ]);
    expect(picker.value).toBe(REPO);
    expect(within(dialog).getByText('Under ~/code.')).toBeTruthy();
  });

  it('closes with Cancel and with Escape, and gives focus back to the button', () => {
    renderDashboard(fakeServer(started));
    const button = screen.getByRole('button', { name: 'New session' });
    button.focus();
    fireEvent.click(within(openDialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);

    const dialog = openDialog();
    fireEvent.keyDown(within(dialog).getByLabelText('First prompt'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("isn't offered before the first snapshot", () => {
    render(<Dashboard view={{ state: 'connecting', snapshot: undefined }} />);
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull();
  });
});

describe('New session: starting one', () => {
  it('posts the directory, prompt, name and model with the apiKey, closes, and opens the session once it is listed', async () => {
    const server = fakeServer(started);
    const { update } = renderDashboard(server);
    const dialog = openDialog();
    fireEvent.change(within(dialog).getByLabelText('Directory'), { target: { value: OTHER_REPO } });
    fill(dialog, { prompt: 'Reply with: ready', name: 'pitwall-test-spawn' });
    fireEvent.change(within(dialog).getByLabelText(/^Model/), { target: { value: 'haiku' } });
    await submit(dialog);

    expect(posts(server)).toEqual([
      {
        url: SPAWN_PATH,
        body: { cwd: OTHER_REPO, prompt: 'Reply with: ready', name: 'pitwall-test-spawn', model: 'haiku' },
        headers: expect.objectContaining({ Authorization: `Bearer ${API_KEY}` }),
      },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Started pitwall-test-spawn. Its view opens when it shows up in the list.')).toBeTruthy();

    const spawned = session({ name: 'pitwall-test-spawn', kind: 'background', shortId: 'c0ffee12', state: 'working', cwd: OTHER_REPO });
    update(snap([session({ name: 'demo-docs' }), spawned]));
    await settle();
    expect(screen.getByRole('dialog', { name: 'pitwall-test-spawn' })).toBeTruthy();
    expect(screen.queryByText(/Its view opens when/)).toBeNull();
  });

  it('leaves out an empty name and the default model, and uses a typed directory and model', async () => {
    const server = fakeServer(started, started);
    renderDashboard(server);
    let dialog = openDialog();
    fill(dialog, { prompt: 'first' });
    await submit(dialog);

    dialog = openDialog();
    fireEvent.change(within(dialog).getByLabelText('Directory'), { target: { value: '\u0000other' } });
    fireEvent.change(within(dialog).getByLabelText('Directory path'), { target: { value: `  ${ROOT}/new-thing  ` } });
    fireEvent.change(within(dialog).getByLabelText(/^Model/), { target: { value: '\u0000other' } });
    fireEvent.change(within(dialog).getByLabelText('Model alias'), { target: { value: 'claude-haiku-4-5' } });
    fill(dialog, { prompt: 'second' });
    await submit(dialog);

    expect(posts(server).map((post) => post.body)).toEqual([
      { cwd: REPO, prompt: 'first' },
      { cwd: `${ROOT}/new-thing`, prompt: 'second', model: 'claude-haiku-4-5' },
    ]);
  });

  it("says what's wrong before sending: no prompt, a bad name, a path outside the roots, a bad model", async () => {
    const server = fakeServer(started);
    renderDashboard(server);
    const dialog = openDialog();
    await submit(dialog);
    expect(within(dialog).getByText('Write the first prompt.')).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByLabelText('First prompt'));

    fill(dialog, { prompt: 'go', name: 'bad;name' });
    await submit(dialog);
    expect(within(dialog).queryByText('Write the first prompt.')).toBeNull();
    expect(within(dialog).getByText(/Letters, digits, spaces/)).toBeTruthy();

    fill(dialog, { name: '' });
    fireEvent.change(within(dialog).getByLabelText('Directory'), { target: { value: '\u0000other' } });
    await submit(dialog);
    expect(within(dialog).getByText('Choose a directory.')).toBeTruthy();
    for (const [path, problem] of [
      ['code/demo-app', 'Use an absolute path, starting with /.'],
      ['/Users/example/codex', 'Use a directory under ~/code.'],
      ['/etc', 'Use a directory under ~/code.'],
    ]) {
      fireEvent.change(within(dialog).getByLabelText('Directory path'), { target: { value: path } });
      expect(within(dialog).getByText(problem as string)).toBeTruthy();
    }
    fireEvent.change(within(dialog).getByLabelText('Directory path'), { target: { value: `${REPO}/sub` } });

    fireEvent.change(within(dialog).getByLabelText(/^Model/), { target: { value: '\u0000other' } });
    await submit(dialog);
    expect(within(dialog).getByText('Type a model alias, or choose the default.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Model alias'), { target: { value: 'opus 4' } });
    expect(within(dialog).getByText(/A short alias such as sonnet/)).toBeTruthy();

    expect(posts(server)).toEqual([]);
  });

  it('shows "Starting…" and ignores Escape and a second submit while the request is out', async () => {
    let answer: (response: Response) => void = () => {};
    const server = vi.fn<FetchLike>(() => new Promise<Response>((resolve) => (answer = resolve)));
    renderDashboard(server);
    const dialog = openDialog();
    fill(dialog, { prompt: 'go' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await settle();

    const busy = within(dialog).getByRole('button', { name: 'Starting…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect((within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.submit(dialog.querySelector('form')!);
    expect(screen.getByRole('dialog', { name: 'New session' })).toBe(dialog);
    expect(server).toHaveBeenCalledTimes(1);

    answer(new Response(JSON.stringify(started.body), { status: 201 }));
    await settle();
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
  });

  it('keeps the session view behind it open on Escape', async () => {
    renderDashboard(fakeServer(started));
    fireEvent.click(screen.getByRole('button', { name: 'demo-docs' }));
    await settle();
    const view = screen.getByRole('dialog', { name: 'demo-docs' });
    const dialog = openDialog();
    fireEvent.keyDown(within(dialog).getByLabelText('First prompt'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'demo-docs' })).toBe(view);
  });
});

describe('New session: when it is refused', () => {
  const untrusted = {
    status: 422,
    body: {
      ok: false,
      error: `Workspace not trusted. Run \`claude\` in ${REPO} once and accept the trust prompt, then retry.`,
      hint: `cd ${REPO} && claude`,
    },
  };

  it("shows Claude Code's untrusted-workspace error, and the command to run with a copy button", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderDashboard(fakeServer(untrusted));
    const dialog = openDialog();
    fill(dialog, { prompt: 'go' });
    await submit(dialog);

    const alert = within(dialog).getByRole('alert');
    expect(within(alert).getByText(untrusted.body.error)).toBeTruthy();
    expect(within(alert).getByText(/never trusts a directory for you/)).toBeTruthy();
    expect(within(alert).getByText(`cd ${REPO} && claude`, { selector: 'code' })).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: 'Copy' }));
    await settle();
    expect(writeText).toHaveBeenCalledWith(`cd ${REPO} && claude`);
    // Still open, so the user can trust the directory and try again.
    expect(screen.getByRole('dialog', { name: 'New session' })).toBe(dialog);
  });

  it('shows any other error without a command, and a status when the answer is not JSON', async () => {
    renderDashboard(fakeServer({ status: 429, body: { ok: false, error: 'Another session is still starting. Try again in a moment.' } }, { status: 500 }));
    const dialog = openDialog();
    fill(dialog, { prompt: 'go' });
    await submit(dialog);
    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toBe('Another session is still starting. Try again in a moment.');
    expect(within(alert).queryByRole('button', { name: 'Copy' })).toBeNull();

    await submit(dialog);
    expect(within(dialog).getByRole('alert').textContent).toBe("Couldn't start the session (HTTP 500).");
  });
});

describe('spawn helpers', () => {
  it('directoryChoices dedupes, keeps group order, and drops groups outside the roots', () => {
    const s = snapshot(
      [
        group({ key: '/r/b', label: 'b', sessions: [] }),
        group({ key: '/r/a', label: 'a', sessions: [] }),
        group({ key: '/r/a', label: 'a', root: '/r2', sessions: [] }),
        group({ key: '/other/x', label: 'x', sessions: [] }),
      ],
      { roots: ['/r', '/r2'] },
    );
    expect(directoryChoices(s).map((choice) => choice.path)).toEqual(['/r/b', '/r/a', '/r', '/r2']);
  });

  it('the field checks match the server rules', () => {
    expect(directoryProblem('/r', ['/r'])).toBeUndefined();
    expect(directoryProblem('/r/', ['/r'])).toBeUndefined();
    expect(directoryProblem('/r/x/y', ['/q', '/r'])).toBeUndefined();
    expect(directoryProblem('/rx', ['/r'])).toMatch(/under/);
    expect(directoryProblem('/r/\u0007', ['/r'])).toMatch(/control/);
    for (const name of ['', 'pitwall-test-spawn', 'Fix the docs 2.0', '_x', 'x'.repeat(64)]) expect(nameProblem(name), name).toBeUndefined();
    for (const name of ['-h', ' x', 'x ', 'a;b', 'naïve', 'x'.repeat(65)]) expect(nameProblem(name), name).toBeDefined();
    for (const model of ['', 'haiku', 'claude-haiku-4-5', 'x'.repeat(40)]) expect(modelProblem(model), model).toBeUndefined();
    for (const model of ['-x', 'opus 4', 'sonnet[1m]', 'x'.repeat(41)]) expect(modelProblem(model), model).toBeDefined();
    expect(promptProblem(' \n')).toBeDefined();
    expect(promptProblem('x'.repeat(16_384))).toBeUndefined();
    expect(promptProblem('x'.repeat(16_385))).toBeDefined();
  });
});
