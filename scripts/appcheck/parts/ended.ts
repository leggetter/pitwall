// Ended interactive sessions (W67; docs/design-system.md, 4: Ended sessions, Finished section, and
// Session view: header, tabs and footer): muted in their group's Finished section, labelled Ended,
// never in Needs you; those older than 7 days, and a group with nothing else, only with Show older,
// which keeps focus and isn't kept across a reload; an ended session's view, with the Conversation
// tab alone and Copy command and Resume in background in its footer; Copy command's command; a
// resume that works, after which the view opens the Terminal tab, attached, with no keyboard, the
// snapshot arriving after the answer or before it; each way a resume fails, as the fake server
// answers each session by its name; one whose directory's path has a `'`, with no command to copy in
// the footer, the menu or a refused resume's alert, and the note saying why (W87); and a copy's
// warning kept in its toast once the snapshot lists the original as running in its terminal, which
// takes the footer away.

import { COPY_SHORT_ID, DEMO_APP, NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { attachStatus, chooseInRepoList, focused, inTerminal, openFinished, openFromRow, openRepoList, repoLabels, row, rowNames, shownHint, toasts, VIEW, viewName, viewTab } from './_dom.js';

const q = JSON.stringify;
const SUMMARY = `document.querySelector('.session-list .summary-count')?.textContent`;
const TOGGLE = `document.querySelector('.session-list .finished-toggle')?.textContent`;
const OLDER = `document.querySelector('.session-list [data-older-toggle]')`;
/** The names of the rows shown whose status is Ended, in order. */
const ENDED_ROWS = `[...document.querySelectorAll('.session-list .finished-sessions li.session')].filter((li) => !li.closest('[hidden]') && li.querySelector('.badge.state-ended')?.textContent === 'Ended').map((li) => li.querySelector('.session-name').textContent.trim())`;
const TABS = `[...${VIEW}.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent.trim())`;
const NOTE = `${VIEW}?.querySelector('.ended-foot .session-view-note')?.textContent`;
const ACTIONS = `[...(${VIEW}?.querySelectorAll('.ended-actions button') ?? [])].map((b) => b.textContent.trim())`;
const footButton = (label: string) => `[...(${VIEW}?.querySelectorAll('.ended-actions button') ?? [])].find((b) => b.textContent.trim() === ${q(label)})`;
const ALERT = `${VIEW}?.querySelector('.resume-failure')`;
const NOTE_TEXT = 'It ended when its Claude Code process exited. Resume it here in the background, or copy the command that resumes it in a terminal.';
const GONE_TEXT = "It ended when its Claude Code process exited, and its directory no longer exists, so it can't be resumed.";
/** A directory whose path has a `'`, which zsh and bash read one way inside single quotes and fish another (W87). In demo-app's group, as a worktree is. */
const QUOTED_DIR = `${DEMO_APP}/.claude/worktrees/pitwall-test-it's-fixed`;
const NO_COMMAND_TEXT = "It ended when its Claude Code process exited. Resume it here in the background; its directory's path has a ' or \\, which shells don't all read the same way, so there's no command to copy.";
const COPY_TEXT = `It was open in another Claude Code process after all, so Claude Code started a copy as ${COPY_SHORT_ID} instead. The copy is listed as a background session with no name, which you can stop and remove.`;
const ON_A_TAB = `document.activeElement?.getAttribute('role') === 'tab' && !!document.activeElement.closest('section.session-view')`;

/** The ways a resume fails, by the session the fake server fails it for, in W66's words. */
const FAILURES = [
  {
    name: NAMES.endedAsked,
    what: "422, not trusted: Claude Code's line, and the command to run",
    tone: 'danger',
    text: `Couldn't resume the session. Workspace not trusted. Run \`claude\` in ${DEMO_APP} once and accept the trust prompt, then retry.pitwall never trusts a directory for you. Run this in a terminal, accept Claude Code's trust prompt, then resume it again:`,
    command: `cd ${DEMO_APP} && claude`,
  },
  {
    name: NAMES.endedCopy,
    what: "409, a copy started instead: a warning in the server's words alone, and a toast, which is what announces it",
    tone: 'warning',
    text: `Claude Code started a copy instead${COPY_TEXT}`,
    toast: `Couldn't resume ${NAMES.endedCopy}. ${COPY_TEXT}`,
  },
  {
    name: NAMES.endedBusy,
    what: "429: a danger alert with pitwall's reason",
    tone: 'danger',
    text: "Couldn't resume the session. pitwall is already running 4 stop, remove, resume or open commands. Try again in a moment.",
  },
  {
    name: NAMES.endedRefused,
    what: '409, running again: a danger alert with the reason',
    tone: 'danger',
    text: "Couldn't resume the session. It's running again, in a terminal or in the background, so pitwall didn't resume it: that would start a copy.",
  },
  {
    name: NAMES.endedSlow,
    what: '504, too slow: a danger alert with the reason',
    tone: 'danger',
    text: "Couldn't resume the session. claude --resume didn't finish within 30s. The session may still appear in the list.",
  },
  { name: NAMES.endedNoAnswer, what: "no answer: a danger alert, pitwall's sentence alone", tone: 'danger', text: "Couldn't resume the session." },
] as const;

const part: Part = {
  name: 'ended',
  title: 'Ended sessions: muted under Finished, never in Needs you; Show older; the view; Copy command; each result of Resume in background',
  async run(t) {
    const { page, server } = t;
    const id = (name: string) => server.world.byName(name).sessionId;
    /** The repo list's labels: in the columns, or below 900 px in the drawer, opened and shut again. */
    const labels = async () => {
      await openRepoList(t);
      const shown = await page.evaluate<string[]>(repoLabels);
      if (t.layout === 'drawer') {
        await page.key('Escape');
        await page.waitFor('the drawer to close', `!document.querySelector('.repo-drawer')`);
      }
      return shown;
    };
    /** Opens a session's view from the URL, as a link or a reload would. */
    const openFromUrl = async (name: string) => {
      await page.navigate(`/?view=all&session=${id(name)}`);
      await page.waitFor(`the ${name} view`, `${viewName} === ${q(name)}`, 10_000);
    };

    await t.step('ended sessions are in their group’s Finished section, labelled Ended, muted, and never in Needs you', async () => {
      await t.fresh({ search: '?view=all' });
      // Eighteen sessions, pitwall-test-ended-pr among them, and five PR rows (W106).
      t.expectEqual(await page.evaluate(SUMMARY), '24 sessions', 'the summary counts the ones from the last 7 days');
      t.expectEqual(await page.evaluate(TOGGLE), 'Finished (9) · 1 asked you', 'the finished background session and the eight ended ones, one of which asked');
      await openFinished(t);
      t.expectEqual(
        await page.evaluate(ENDED_ROWS),
        [NAMES.endedAsked, NAMES.ended, NAMES.endedCopy, NAMES.endedBusy, NAMES.endedRefused, NAMES.endedNoAnswer, NAMES.endedSlow, NAMES.endedGone],
        'the ended rows, newest first',
      );
      t.expect(
        await page.evaluate(`[...document.querySelectorAll('.session-list .finished-sessions li.session')].filter((li) => li.querySelector('.badge.state-ended')).every((li) => li.classList.contains('finished'))`),
        'each is muted, as a finished row is',
      );
      // W106: an ended session that owns an open PR isn't finished work. It's listed with the rest, not muted, and still says Ended.
      const owner = await page.evaluate<{ finished: boolean; muted: boolean; badge: string; pr: string } | null>(`(() => {
        const li = ${row(NAMES.endedPr)}?.closest('li.session');
        return li ? { finished: !!li.closest('.finished-sessions'), muted: li.classList.contains('finished'), badge: li.querySelector('.badge.state-ended')?.textContent ?? '', pr: li.querySelector('.pr-badge')?.textContent ?? '' } : null;
      })()`);
      t.expectEqual(owner, { finished: false, muted: false, badge: 'Ended', pr: 'Pull request #31' }, 'the ended session that owns an open PR, with the rest');
      const names = await page.evaluate<string[]>(rowNames);
      t.expect(!names.includes(NAMES.endedOld) && !names.includes(NAMES.endedOldOnly), 'none older than 7 days', names);
      await t.shot('finished');
      await chooseInRepoList(t, 'Needs you');
      t.expect(!(await page.evaluate<string[]>(rowNames)).includes(NAMES.endedAsked), 'the one that asked isn’t in Needs you');
    });

    await t.step('older ones, and a group of them alone, show only with Show older, which keeps focus as Hide older', async () => {
      await chooseInRepoList(t, 'All sessions');
      await openFinished(t);
      t.expect(!(await labels()).includes('docs-site'), 'docs-site, whose only session is older, isn’t in the repo list');
      t.expectEqual(await page.evaluate(`${OLDER}?.textContent`), 'Show 2 older sessions', 'Show older says how many');
      await page.click('Show 2 older sessions', OLDER);
      await page.waitFor('Hide older', `${OLDER}?.textContent === 'Hide older sessions'`);
      t.expectEqual(await page.evaluate(focused), 'Hide older sessions', 'focus stays on the button, under its other name');
      const names = await page.evaluate<string[]>(rowNames);
      t.expect(names.includes(NAMES.endedOld) && names.includes(NAMES.endedOldOnly), 'the older ones are listed', names);
      t.expectEqual(names.slice(-2), [NAMES.endedOld, NAMES.endedOldOnly], 'last, oldest last');
      t.expectEqual(await page.evaluate(SUMMARY), '26 sessions', 'and counted');
      t.expect((await labels()).includes('docs-site'), 'docs-site is in the repo list');
      await t.shot('show-older');
    });

    await t.step('Show older isn’t kept across a reload', async () => {
      await page.reload();
      await page.waitFor('the list', `${rowNames}.length > 0`, 10_000);
      t.expectEqual(await page.evaluate(`${OLDER}?.textContent`), 'Show 2 older sessions', 'off again');
      t.expect(!(await page.evaluate<string[]>(rowNames)).includes(NAMES.endedOld), 'the older ones hidden again');
      t.expect(!(await page.evaluate<boolean>(`Object.keys(localStorage).some((key) => /older|ended/i.test(key))`)), 'nothing about it in localStorage');
    });

    await t.step('an ended session’s view: the Conversation tab alone, Ended, and the footer’s note, Copy command and Resume in background', async () => {
      await openFromRow(t, NAMES.ended);
      await page.settle(150);
      // It was given #19, which pitwall-test-from-root owns since it pushed it, so its Pull requests tab lists it (W106).
      t.expectEqual(await page.evaluate(TABS), ['Conversation', 'Pull requests (1)'], 'the Conversation tab alone, and Pull requests');
      t.expectEqual(await page.evaluate(`${VIEW}.querySelector('.session-view-meta .badge.state-ended')?.textContent`), 'Ended', 'Ended where the status goes');
      t.expect(!(await page.evaluate(`!!${VIEW}.querySelector('.relay-box')`)), 'no message box');
      t.expectEqual(await page.evaluate(NOTE), NOTE_TEXT, 'the note');
      t.expectEqual(await page.evaluate(ACTIONS), ['Copy command', 'Resume in background'], 'Copy command, then Resume in background');
      t.expect(await page.evaluate(`${footButton('Resume in background')}.classList.contains('primary')`), 'Resume in background is the primary');
      await t.shot('view');
      await page.click('Session actions', `${VIEW}.querySelector('button[aria-label="Session actions"]')`);
      await page.waitFor('the menu', `!!${VIEW}.querySelector('[role="menu"]')`);
      const items = await page.evaluate<string[]>(`[...${VIEW}.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim())`);
      t.expect(items.includes('Copy resume command') && items.includes('Resume in background'), 'the menu has both', items);
      t.expect(!items.includes('Stop session') && !items.includes('Remove session'), 'and no Stop or Remove', items);
      await page.key('Escape');
      await page.waitFor('the menu to close', `!${VIEW}.querySelector('[role="menu"]')`);
    });

    await t.step('Copy command copies the command that resumes it in a terminal, with Copied', async () => {
      // A stand-in for the clipboard that records what's written: the check never touches a real one.
      await page.evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: (text) => { window.__copied = text; return Promise.resolve(); } }), true`);
      await page.click('Copy command', footButton('Copy command'));
      await page.waitFor('Copied', `${toasts}.includes('Copied')`);
      t.expectEqual(await page.evaluate('window.__copied'), `cd '${DEMO_APP}' && claude --resume ${id(NAMES.ended)}`, 'the command, its directory quoted');
    });

    await t.step('Resume in background: a toast, then the Terminal tab, attached, the keyboard left on the tab, and the star kept', async () => {
      const sessionId = id(NAMES.ended);
      await t.fresh({ search: `?view=all&session=${sessionId}`, storage: { 'pitwall.starred.v1': JSON.stringify({ v: 1, ids: [sessionId] }) } });
      await page.waitFor('its view', `${viewName} === ${q(NAMES.ended)}`);
      await page.click('Resume in background', footButton('Resume in background'));
      await page.waitFor('the toast', `${toasts}.includes(${q(`Resumed ${NAMES.ended} in the background.`)})`);
      t.expectEqual(server.records.resumes, [NAMES.ended], 'one resume, of it');
      await page.waitFor('the Terminal tab', `${viewTab} === 'Terminal'`, 5000);
      await page.waitFor('the attach', `${attachStatus} === 'attached'`, 5000);
      await page.settle(200);
      t.expectEqual(server.records.attaches.map((each) => ({ name: each.name, restart: each.restart })), [{ name: NAMES.ended, restart: false }], 'attached once, with no restart');
      t.expect(await page.evaluate(`document.activeElement?.getAttribute('role') === 'tab'`), 'focus is on the Terminal tab', await page.evaluate(focused));
      t.expect(!(await page.evaluate(inTerminal)), 'the terminal took no keyboard');
      t.expectEqual(await page.evaluate(shownHint), 'type', 'its bar says how to type to it');
      t.expectEqual(await page.evaluate(`${VIEW}.querySelector('button.star-toggle')?.getAttribute('aria-pressed')`), 'true', 'still starred, by the same id');
      // W69: you resumed it, so it needs your prompt, though Claude Code's "send a prompt to start" asks nothing.
      t.expectEqual(await page.evaluate(`${VIEW}.querySelector('.session-view-meta .badge[data-status]')?.textContent`), 'Waiting for your prompt', 'its badge waits for your prompt');
      await t.shot('resumed');
    });

    await t.step('Resume in background, listed as running before the server answers: the Terminal tab all the same, focus moved from Resume to it', async () => {
      const sessionId = id(NAMES.ended);
      await t.fresh({ search: `?view=all&session=${sessionId}` });
      server.resumeOrder.listedFirst = true;
      await page.waitFor('its view', `${viewName} === ${q(NAMES.ended)}`);
      await page.click('Resume in background', footButton('Resume in background'));
      await page.waitFor('the Terminal tab', `${viewTab} === 'Terminal'`, 5000);
      t.expect(!(await page.evaluate<string[]>(toasts)).some((each) => each.startsWith('Resumed')), 'before the server answered', await page.evaluate(toasts));
      t.expect(await page.evaluate(ON_A_TAB), 'focus moved to the Terminal tab, not the page', await page.evaluate(focused));
      await page.waitFor('the toast', `${toasts}.includes(${q(`Resumed ${NAMES.ended} in the background.`)})`, 5000);
      await page.waitFor('the attach', `${attachStatus} === 'attached'`, 5000);
      await page.settle(200);
      t.expectEqual(server.records.resumes, [NAMES.ended], 'one resume, of it');
      t.expectEqual(server.records.attaches.map((each) => ({ name: each.name, restart: each.restart })), [{ name: NAMES.ended, restart: false }], 'attached once, with no restart');
      t.expectEqual(await page.evaluate(viewTab), 'Terminal', 'still on the Terminal tab after the answer');
      t.expect(await page.evaluate(ON_A_TAB), 'focus still on the tab', await page.evaluate(focused));
      t.expect(!(await page.evaluate(inTerminal)), 'the terminal took no keyboard');
      await t.shot('resumed-listed-first');
    });

    for (const failure of FAILURES) {
      await t.step(`a resume that fails, ${failure.what}`, async () => {
        const sessionId = id(failure.name);
        server.clearRecords();
        // The refusal is what this step asks for: the page reports its HTTP status, or the closed connection, as a failed request.
        t.allow(new RegExp(`/api/sessions/${sessionId}/resume$`), 'the refused resume this step asks for');
        await openFromUrl(failure.name);
        await page.click('Resume in background', footButton('Resume in background'));
        await page.waitFor('the alert', `!!${ALERT}`, 5000);
        await page.settle(100);
        t.expect(await page.evaluate(`${ALERT}.classList.contains(${q(failure.tone)})`), `a ${failure.tone} alert`, await page.evaluate(`${ALERT}.className`));
        if ('toast' in failure) {
          // Its toast outlives the footer, and announces it, so the warning has no role of its own.
          t.expectEqual(await page.evaluate(`${ALERT}.getAttribute('role')`), null, 'not announced by the footer');
          t.expect((await page.evaluate<string[]>(toasts)).includes(failure.toast), 'announced by its toast', await page.evaluate(toasts));
        } else {
          t.expectEqual(await page.evaluate(`${ALERT}.getAttribute('role')`), 'alert', 'announced');
          t.expectEqual(await page.evaluate(toasts), [], 'no toast');
        }
        const shown = await page.evaluate<string>(`${ALERT}.textContent`);
        t.expect(shown.startsWith(failure.text), 'what it says', shown);
        if (failure.tone === 'warning') t.expect(!(await page.evaluate(`!!${ALERT}.querySelector('.alert-detail')`)), "the server's sentence alone, as text");
        if ('command' in failure) t.expectEqual(await page.evaluate(`${ALERT}.querySelector('.command-chip')?.textContent`), failure.command, 'the command to run, in a chip');
        t.expectEqual(await page.evaluate(focused), 'Resume in background', 'focus stays on Resume in background');
        t.expect(await page.evaluate(`${footButton('Resume in background')}.getAttribute('aria-busy') === null`), 'which is idle again');
        t.expectEqual(server.records.attaches, [], 'nothing attached');
        await t.shot(`failed-${failure.name}`);
      });
    }

    await t.step("one whose directory's path has a ' has no command to copy, in the footer, the menu or a refused resume's alert, and says why (W87)", async () => {
      server.clearRecords();
      server.world.move(id(NAMES.endedAsked), QUOTED_DIR);
      server.broadcast();
      t.allow(new RegExp(`/api/sessions/${id(NAMES.endedAsked)}/resume$`), 'the refused resume this step asks for');
      await openFromUrl(NAMES.endedAsked);
      await page.settle(100);
      t.expectEqual(await page.evaluate(NOTE), NO_COMMAND_TEXT, 'the note says why there’s none');
      t.expectEqual(await page.evaluate(`[...${VIEW}.querySelectorAll('.ended-foot .session-view-note code')].map((code) => code.textContent)`), ["'", '\\'], "its ' and \\ in code style");
      t.expectEqual(await page.evaluate(ACTIONS), ['Resume in background'], 'Resume in background alone');
      await t.shot('no-command');
      await page.click('Session actions', `${VIEW}.querySelector('button[aria-label="Session actions"]')`);
      await page.waitFor('the menu', `!!${VIEW}.querySelector('[role="menu"]')`);
      const items = await page.evaluate<string[]>(`[...${VIEW}.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent.trim())`);
      t.expect(!items.includes('Copy resume command') && items.includes('Resume in background'), 'no Copy resume command in the menu', items);
      await page.key('Escape');
      await page.waitFor('the menu to close', `!${VIEW}.querySelector('[role="menu"]')`);
      await page.click('Resume in background', footButton('Resume in background'));
      await page.waitFor('the alert', `!!${ALERT}`, 5000);
      await page.settle(100);
      const shown = await page.evaluate<string>(`${ALERT}.textContent`);
      t.expectEqual(
        shown,
        `Couldn't resume the session. Workspace not trusted. Run \`claude\` in ${QUOTED_DIR} once and accept the trust prompt, then retry.`,
        "Claude Code's line alone: the footer's note already says why there's no command",
      );
      t.expect(!(await page.evaluate(`!!${ALERT}.querySelector('.command-chip')`)), 'no command chip');
      t.expectEqual(server.records.resumes, [NAMES.endedAsked], 'one resume, of it');
      await t.shot('no-command-refused');
    });

    await t.step('one whose directory has gone says it can’t be resumed, with nothing to press', async () => {
      await openFromUrl(NAMES.endedGone);
      await page.settle(100);
      t.expectEqual(await page.evaluate(NOTE), GONE_TEXT, 'the note');
      t.expectEqual(await page.evaluate(ACTIONS), [], 'no Copy command or Resume in background');
      t.expectEqual(await page.evaluate(`${VIEW}.querySelector('.session-view-missing')?.textContent`), 'Directory no longer exists', 'line 2 says the directory has gone');
      await t.shot('gone');
    });

    await t.step('a copy started instead, then the original listed as running in its terminal: the footer goes, the toast stays, focus on the Terminal tab', async () => {
      server.clearRecords();
      server.resumeOrder.copyReopens = true;
      t.allow(new RegExp(`/api/sessions/${id(NAMES.endedCopy)}/resume$`), 'the refused resume this step asks for');
      await openFromUrl(NAMES.endedCopy);
      await page.click('Resume in background', footButton('Resume in background'));
      const toast = `Couldn't resume ${NAMES.endedCopy}. ${COPY_TEXT}`;
      await page.waitFor('the toast', `${toasts}.includes(${q(toast)})`, 5000);
      await page.waitFor('the footer to go', `!${VIEW}?.querySelector('.ended-foot')`, 5000);
      await page.settle(100);
      t.expect(await page.evaluate(`!!${VIEW}.querySelector('.relay-box')`), 'the message box in its place: it is running in its terminal');
      t.expect((await page.evaluate<string[]>(toasts)).includes(toast), 'the warning stays, in its toast', await page.evaluate(toasts));
      t.expect(await page.evaluate(ON_A_TAB), 'focus moved from Resume to the Terminal tab, not the page', await page.evaluate(focused));
      t.expectEqual(await page.evaluate(viewTab), 'Conversation', 'an interactive session: still on Conversation');
      t.expectEqual(server.records.attaches, [], 'nothing attached');
      await t.shot('copy-reopened');
    });
  },
};

export default part;
