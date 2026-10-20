// The page alerts at the top of the session list, and the app strip above the header (W24). Made-up
// sessions only.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexSnapshot, RelayAlert, RelayOff } from '../../../src/shared/protocol.js';
import type { ConnectionView } from '../connection.js';
import { memoryNavigation } from '../selection.js';
import { group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { Dashboard } from './Dashboard.js';

const SENT: RelayAlert = { at: minutesAgo(2), detail: 'a SendMessage nobody asked for, made up for the test.', count: 1, blocked: false };
const BLOCKED: RelayAlert = { at: minutesAgo(1), detail: 'a SendMessage nobody asked for, blocked, made up for the test.', count: 3, blocked: true };
const OFF: RelayOff = { since: minutesAgo(2), reason: "its gate didn't check a SendMessage call." };

const base = () => snapshot([group({ sessions: [session({ name: 'pitwall-test-one' })] })]);

/** Renders the dashboard with `first`, and returns a way to send it the next view, as the connection would. */
function renderViews(first: ConnectionView) {
  const navigation = memoryNavigation();
  const { rerender, container } = render(<Dashboard view={first} navigation={navigation} />);
  return { container, next: (view: ConnectionView) => rerender(<Dashboard view={view} navigation={navigation} />) };
}

const live = (snap: IndexSnapshot, extra: Partial<ConnectionView> = {}): ConnectionView => ({ state: 'live', snapshot: snap, ...extra });
const strip = () => document.querySelector('.app-strip');
const relayAlert = () => document.querySelector<HTMLElement>('.relay-alert');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

describe('the app strip', () => {
  it('shows only while the snapshot says the relay is off, never from a relay alert alone', () => {
    const { next } = renderViews(live(base()));
    expect(strip()).toBeNull();
    // An alert that wasn't blocked may only have restarted the relay.
    next(live({ ...base(), relayAlert: SENT }));
    expect(strip()).toBeNull();
    next(live({ ...base(), relayAlert: BLOCKED }));
    expect(strip()).toBeNull();
    next(live({ ...base(), relayAlert: SENT, relayOff: OFF }));
    expect(strip()?.textContent).toBe("Messaging is off until you restart pitwall: its gate didn't check a SendMessage call.Details");
    // And it goes when the snapshot says the relay can be used, as after a restart.
    next(live(base()));
    expect(strip()).toBeNull();
  });

  it('sits above the header, as the app’s first row', () => {
    const { container } = renderViews(live({ ...base(), relayAlert: SENT, relayOff: OFF }));
    const app = container.querySelector('.app')!;
    expect(app.firstElementChild).toBe(strip());
    expect(app.firstElementChild?.nextElementSibling?.tagName.toLowerCase()).toBe('header');
  });

  it('shows the reason as text, never markup', () => {
    renderViews(live({ ...base(), relayAlert: SENT, relayOff: { since: minutesAgo(1), reason: '<b>made up</b>\u001b[31m.' } }));
    expect(strip()?.querySelector('b')).toBeNull();
    expect(strip()?.textContent).toBe('Messaging is off until you restart pitwall: <b>made up</b>.Details');
  });

  it('stays when the relay alert is dismissed, and Details brings the alert back, with focus on it', () => {
    renderViews(live({ ...base(), relayAlert: SENT, relayOff: OFF }));
    fireEvent.click(within(relayAlert()!).getByRole('button', { name: 'Dismiss' }));
    expect(relayAlert()).toBeNull();
    expect(strip()).toBeTruthy();
    // Dismiss goes with its alert, so focus goes to the session list's heading.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'All sessions' }));

    fireEvent.click(within(strip() as HTMLElement).getByRole('button', { name: 'Details' }));
    expect(relayAlert()).toBeTruthy();
    expect(document.activeElement).toBe(relayAlert());
    expect(relayAlert()?.textContent).toContain('Messaging is off until you restart pitwall.');
  });

  it('has no Details when there’s no relay alert to show', () => {
    renderViews(live({ ...base(), relayOff: OFF }));
    expect(strip()).toBeTruthy();
    expect(within(strip() as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('has no Dismiss of its own', () => {
    renderViews(live({ ...base(), relayAlert: SENT, relayOff: OFF }));
    expect(within(strip() as HTMLElement).queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });
});

describe('the relay alert', () => {
  it('says pitwall blocked one, as a warning, with the count and the latest detail in code style', () => {
    const { next } = renderViews(live(base()));
    next(live({ ...base(), relayAlert: BLOCKED }));
    const alert = relayAlert()!;
    expect(alert.className).toContain('warning');
    expect(alert.querySelector('.inline-alert-title')?.textContent).toBe("pitwall blocked a message you didn't ask for");
    expect(alert.textContent).toContain('so nothing was sent.');
    expect(alert.textContent).toContain('3 times since pitwall started.');
    expect(alert.querySelector('.alert-detail')?.textContent).toBe(BLOCKED.detail);
    expect(alert.textContent).not.toContain('Messaging is off');
  });

  it('says one may have been sent, as danger, and only says messaging is off when it is', () => {
    const { next } = renderViews(live(base()));
    next(live({ ...base(), relayAlert: SENT }));
    expect(relayAlert()?.className).toContain('danger');
    expect(relayAlert()?.querySelector('.inline-alert-title')?.textContent).toBe("pitwall's relay may have sent a message you didn't ask for");
    expect(relayAlert()?.textContent).toContain('Once since pitwall started.');
    expect(relayAlert()?.textContent).not.toMatch(/stopped using|Messaging is off/);
    next(live({ ...base(), relayAlert: SENT, relayOff: OFF }));
    expect(relayAlert()?.textContent).toContain('Messaging is off until you restart pitwall.');
  });

  it('stays dismissed until its time or count changes', () => {
    const { next } = renderViews(live(base()));
    next(live({ ...base(), relayAlert: SENT }));
    fireEvent.click(within(relayAlert()!).getByRole('button', { name: 'Dismiss' }));
    next(live({ ...base(), relayAlert: { ...SENT } }));
    expect(relayAlert()).toBeNull();
    next(live({ ...base(), relayAlert: { ...SENT, at: minutesAgo(0) } }));
    expect(relayAlert()).toBeTruthy();
    fireEvent.click(within(relayAlert()!).getByRole('button', { name: 'Dismiss' }));
    next(live({ ...base(), relayAlert: { ...SENT, at: minutesAgo(0), count: 2 } }));
    expect(relayAlert()?.textContent).toContain('2 times since pitwall started.');
  });

  it('has a ghost sm Dismiss, not a link on its tint', () => {
    renderViews(live({ ...base(), relayAlert: SENT }));
    const dismiss = within(relayAlert()!).getByRole('button', { name: 'Dismiss' });
    expect(dismiss.className).toBe('button ghost sm');
    expect(relayAlert()?.querySelector('.link-button')).toBeNull();
  });
});

describe('the page alerts’ roles', () => {
  it('announce a warning or danger alert that arrives live, and not one that was there on load', () => {
    const failing = { ...base(), source: { ok: false as const, error: 'made up' } };
    const { next } = renderViews(live(failing, { serverError: 'made-up server error' }));
    const roles = () => [...document.querySelectorAll('.session-list-alerts > .inline-alert')].map((alert) => alert.getAttribute('role'));
    // On load: neither is announced.
    expect(roles()).toEqual([null, null]);

    // A relay alert arrives: announced. The others are unchanged, so still not.
    next(live({ ...failing, relayAlert: BLOCKED }, { serverError: 'made-up server error' }));
    expect(roles()).toEqual([null, 'alert', null]);

    // The poll's error changes: that's a new alert, so it's announced.
    next(live({ ...failing, source: { ok: false, error: 'made up again' }, relayAlert: BLOCKED }, { serverError: 'made-up server error' }));
    expect(roles()).toEqual(['alert', 'alert', null]);
  });

  it('give the neutral ones role="status": connection lost, and session started', () => {
    const { next } = renderViews(live(base()));
    next({ state: 'reconnecting', snapshot: base() });
    const lost = document.querySelector('.session-list-alerts > .inline-alert.neutral');
    expect(lost?.getAttribute('role')).toBe('status');
    expect(lost?.textContent).toBe('Lost the connection to pitwall. Reconnecting; this list may be out of date.');
  });

  it('put each in the session list column, above its header, in order: the poll, the relay, then a server error', () => {
    const { container, next } = renderViews(live(base()));
    next(live({ ...base(), relayAlert: SENT, source: { ok: false, error: 'made up' } }, { serverError: 'made up' }));
    const alerts = container.querySelector('main.session-list > .session-list-alerts')!;
    expect([...alerts.children].map((alert) => alert.className)).toEqual([
      'inline-alert warning',
      'inline-alert danger relay-alert',
      'inline-alert danger',
    ]);
  });
});
