// A pitwall link opened in a new tab (W175, D7): a tab opened at `?session=` with no token asks the pitwall tabs
// already open, and one that is signed in answers, so the new tab shows the session. What it must not do: give the
// token to a page this server didn't serve. The fake server issues and redeems link codes with pitwall's own code.
//
// - a second tab at ?session= shows that session, with the token in its sessionStorage and never in its address;
// - the server confirmed one code for it, and a page with no code of its own, as another process's stale page has,
//   asking on the channel gets no answer, and the server is asked about its made-up hash and denies it;
// - with no signed-in tab open, the second tab shows the notice, which says to keep a pitwall tab open.

import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { STALE_PAGE_PATH } from '../server.js';
import { viewName } from './_dom.js';

const q = JSON.stringify;
const TOKEN_KEY = 'pitwall.token';

const part: Part = {
  name: 'link-new-tab',
  title: 'A pitwall link opened in a new tab: shows the session when another tab is signed in, nothing for a page with no code, the notice when none is',
  viewports: ['375', '1200'],
  async run(t) {
    const { page, server } = t;
    const sessionId = () => server.world.byName(NAMES.conversation).sessionId;
    const view = t.viewport;

    await t.step('a page with no code of its own, asking on the channel, gets no answer, and the server denies its hash', async () => {
      await t.fresh({ search: '?view=all' });
      server.clearRecords();
      // Another process's stale page: same origin, so it can reach the channel and the server, but loaded
      // by no navigation to this server's index, so it holds no code. A static file stands in for it.
      const stale = await page.sibling(view, t.theme);
      try {
        await stale.navigate(STALE_PAGE_PATH);
        const fetched = await stale.evaluate<string>(`fetch('/').then((r) => r.text()).then((html) => /name="pitwall-link" content="([^"]*)"/.exec(html)?.[1] ?? 'no tag')`);
        t.expectEqual(fetched, '', "a script's fetch of the page is given no code");
        const answered = await stale.evaluate<boolean>(`new Promise((resolve) => {
          const channel = new BroadcastChannel('pitwall.link');
          let heard = false;
          channel.onmessage = (event) => { if (event.data && event.data.type === 'link-answer') heard = true; };
          channel.postMessage({ type: 'link-request', hash: 'F'.repeat(43) });
          setTimeout(() => { channel.close(); resolve(heard); }, 1200);
        })`);
        t.expect(!answered, 'no answer came on the channel');
        t.expectEqual(server.records.linkConfirms, [{ hash: 'F'.repeat(43), confirmed: false }], 'the signed-in tab asked the server, which had not issued it');
        t.expect(!(await stale.evaluate<boolean>(`sessionStorage.getItem(${q(TOKEN_KEY)}) !== null`)), 'it holds no token');
      } finally {
        await stale.close();
      }
    });

    await t.step('a stale page that sends its own opener policy, and opens pitwall, finds no code in the window it opened', async () => {
      server.clearRecords();
      const stale = await page.sibling(view, t.theme);
      try {
        await stale.navigate(STALE_PAGE_PATH);
        // window.open arrives as Sec-Fetch-Site: same-origin, so the page it loads has an empty tag. The stale
        // page's COOP matches pitwall's, so it keeps its handle and can read the window, as an attacker's would.
        const seen = await stale.evaluate<string>(`new Promise((resolve) => {
          const w = window.__realOpen('/?view=all');
          setTimeout(() => {
            try {
              const tag = w.document.querySelector('meta[name=pitwall-link]');
              resolve(JSON.stringify({ tag: tag ? tag.getAttribute('content') : 'no tag', token: w.sessionStorage.getItem(${q(TOKEN_KEY)}) }));
            } catch (error) { resolve(JSON.stringify({ error: String(error) })); }
            try { w.close(); } catch {}
          }, 2500);
        })`, { userGesture: true });
        const result = JSON.parse(seen) as { tag?: string; token?: string | null; error?: string };
        t.expectEqual(result.tag, '', 'the window it opened (still readable by it) held an empty link tag: ' + seen);
        t.expect(!result.token, 'and no token');
        t.expectEqual(server.records.linkConfirms, [], 'the server was asked to confirm nothing');
      } finally {
        await stale.close();
      }
    });

    await t.step('a second tab at ?session= shows that session, with the token in its storage and not its address', async () => {
      server.clearRecords();
      const second = await page.sibling(view, t.theme);
      try {
        await second.navigate(`/?view=all&session=${sessionId()}`);
        await second.waitFor('the session view', `${viewName} === ${q(NAMES.conversation)}`, 10_000);
        t.expectEqual(server.records.linkConfirms.map((each) => each.confirmed), [true], 'the server confirmed one code');
        t.expect(await second.evaluate<boolean>(`!!sessionStorage.getItem(${q(TOKEN_KEY)})`), 'its sessionStorage holds the token');
        t.expect(!(await second.evaluate<boolean>(`location.href.includes('token') || localStorage.length > 0 && JSON.stringify({...localStorage}).includes(sessionStorage.getItem(${q(TOKEN_KEY)}))`)), 'the token is in neither its address nor localStorage');
        t.expect(!(await second.evaluate<boolean>(`document.cookie !== ''`)), 'and no cookie');
        t.expectEqual(second.problems.filter((p) => !/off-server/.test(p.kind)).map((p) => `${p.kind}: ${p.text}`), [], 'the second tab had no problems');
        await second.shot(`${t.out}/shots/link-new-tab/${t.at}-second-tab.png`);
      } finally {
        await second.close();
      }
    });

    await t.step('with no signed-in tab open, the second tab says it has no token, and to keep a pitwall tab open', async () => {
      await page.leave();
      const second = await page.sibling(view, t.theme);
      try {
        await second.navigate(`/?view=all&session=${sessionId()}`);
        await second.waitFor('the notice', `document.querySelector('.notice-lead')?.textContent === 'This tab has no token for pitwall.'`, 10_000);
        t.expect((await second.evaluate<string>(`document.querySelector('.notice-detail').textContent`)).includes('keep one open for links to work'), 'it says to keep one open');
        await second.shot(`${t.out}/shots/link-new-tab/${t.at}-no-tab.png`);
      } finally {
        await second.close();
      }
    });
  },
};

export default part;
