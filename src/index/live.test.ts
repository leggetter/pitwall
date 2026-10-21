// A read-only check against the real `claude agents --json` and the real
// transcripts. Runs only with PITWALL_LIVE=1. The root is PITWALL_LIVE_ROOT,
// or the home directory.
//
// It asserts structure only, and every failure message names a field path,
// never a value, so no session or transcript content is printed.

import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IndexSnapshot, SessionSummary } from '../shared/protocol.js';
import { startIndexer } from './index.js';
import { isWithin, resolveCwd } from './roots.js';
import { compareGroups, compareSessions } from './summaries.js';

const live = process.env.PITWALL_LIVE === '1';
const root = process.env.PITWALL_LIVE_ROOT || os.homedir();

const SESSION_KEYS = new Set([
  'sessionId', 'shortId', 'name', 'title', 'titleSource', 'kind', 'cwd', 'cwdMissing', 'pid', 'alive', 'status', 'state',
  'waitingFor', 'startedAt', 'stale', 'finished', 'askedYou', 'lastActivityAt', 'lastUserPrompt', 'transcript',
]);
const GROUP_KEYS = new Set(['key', 'label', 'kind', 'root', 'sessions']);

const isIso = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
const isAbsolute = (v: unknown) => typeof v === 'string' && path.isAbsolute(v);
const oneOf = (v: unknown, values: readonly unknown[]) => values.includes(v);
const optional = (v: unknown, check: (v: unknown) => boolean) => v === undefined || check(v);

function sessionProblems(s: SessionSummary, at: string): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, field: string) => {
    if (!ok) problems.push(`${at}.${field}`);
  };
  for (const key of Object.keys(s)) check(SESSION_KEYS.has(key), `${key} (unknown key)`);
  check(typeof s.sessionId === 'string' && s.sessionId !== '', 'sessionId');
  check(optional(s.shortId, (v) => typeof v === 'string' && v !== ''), 'shortId');
  check(typeof s.name === 'string' && s.name !== '', 'name');
  const isTitle = (v: unknown) =>
    typeof v === 'string' && v !== '' && v.length <= 120 && !/\s\s|\n/.test(v) && v.toLowerCase() !== s.name.toLowerCase();
  check(optional(s.title, isTitle), 'title');
  check((s.title === undefined) === (s.titleSource === undefined), 'titleSource (with title)');
  check(optional(s.titleSource, (v) => v === 'claude-code'), 'titleSource');
  check(oneOf(s.kind, ['interactive', 'background']), 'kind');
  check(isAbsolute(s.cwd), 'cwd');
  check(optional(s.cwdMissing, (v) => v === true), 'cwdMissing');
  check(optional(s.pid, (v) => Number.isInteger(v) && (v as number) > 0), 'pid');
  check(s.alive === (s.pid !== undefined), 'alive');
  check(optional(s.status, (v) => oneOf(v, ['busy', 'waiting', 'idle'])), 'status');
  check(optional(s.state, (v) => oneOf(v, ['working', 'blocked', 'done', 'failed', 'stopped'])), 'state');
  check(optional(s.waitingFor, (v) => typeof v === 'string'), 'waitingFor');
  check(isIso(s.startedAt), 'startedAt');
  check(typeof s.stale === 'boolean', 'stale');
  check(!s.stale || (s.kind === 'background' && s.state === 'blocked'), 'stale (conditions)');
  check(typeof s.finished === 'boolean', 'finished');
  check(
    s.finished === (s.kind === 'background' && !s.alive && oneOf(s.state, ['done', 'stopped', 'failed'])),
    'finished (conditions)',
  );
  check(!(s.finished && s.stale), 'finished (with stale)');
  check(
    optional(s.askedYou, (v) => {
      const asked = v as SessionSummary['askedYou'];
      return (
        asked !== undefined &&
        oneOf(asked.reason, ['open-questions', 'question']) &&
        typeof asked.excerpt === 'string' &&
        asked.excerpt.length > 0 &&
        asked.excerpt.length <= 200 &&
        !asked.excerpt.includes('\n')
      );
    }),
    'askedYou',
  );
  check(
    s.askedYou === undefined ||
      (!s.stale && s.transcript === 'ok' && !oneOf(s.status, ['busy', 'waiting']) && !oneOf(s.state, ['working', 'blocked'])),
    'askedYou (conditions)',
  );
  check(oneOf(s.transcript, ['ok', 'missing', 'unreadable']), 'transcript');
  check(s.transcript === 'ok' || s.title === undefined, 'title without ok');
  check(optional(s.lastActivityAt, isIso), 'lastActivityAt');
  check(optional(s.lastUserPrompt, (v) => typeof v === 'string' && v.length > 0 && v.length <= 300), 'lastUserPrompt');
  check(optional(s.lastUserPrompt, (v) => !(v as string).includes('<cross-session-message')), 'lastUserPrompt (cross-session)');
  if (s.transcript !== 'ok') {
    check(
      s.lastActivityAt === undefined && s.lastUserPrompt === undefined && s.askedYou === undefined,
      'transcript fields without ok',
    );
  }
  return problems;
}

async function snapshotProblems(snapshot: IndexSnapshot): Promise<string[]> {
  const problems: string[] = [];
  const check = (ok: boolean, field: string) => {
    if (!ok) problems.push(field);
  };
  check(isIso(snapshot.generatedAt), 'generatedAt');
  check(Array.isArray(snapshot.roots) && snapshot.roots.length === 1 && snapshot.roots.every(isAbsolute), 'roots');
  check(snapshot.source.ok === true, 'source.ok');
  check(Array.isArray(snapshot.groups), 'groups');
  const seen = new Set<string>();
  for (const [g, group] of snapshot.groups.entries()) {
    const at = `groups[${g}]`;
    for (const key of Object.keys(group)) check(GROUP_KEYS.has(key), `${at}.${key} (unknown key)`);
    check(isAbsolute(group.key), `${at}.key`);
    check(typeof group.label === 'string' && group.label !== '', `${at}.label`);
    check(oneOf(group.kind, ['git', 'directory']), `${at}.kind`);
    check(snapshot.roots.includes(group.root), `${at}.root`);
    check(group.sessions.length > 0, `${at}.sessions (empty)`);
    for (const [i, session] of group.sessions.entries()) {
      const sAt = `${at}.sessions[${i}]`;
      problems.push(...sessionProblems(session, sAt));
      check(!seen.has(session.sessionId), `${sAt}.sessionId (duplicate)`);
      seen.add(session.sessionId);
      check(isWithin(group.root, await resolveCwd(session.cwd)), `${sAt}.cwd (outside its root)`);
      const next = group.sessions[i + 1];
      if (next) check(compareSessions(session, next) <= 0, `${sAt} (sort order)`);
    }
    const nextGroup = snapshot.groups[g + 1];
    if (nextGroup) check(compareGroups(group, nextGroup) <= 0, `${at} (sort order)`);
  }
  // A structure check over nothing proves nothing: run it under a root with sessions.
  check(seen.size > 0, 'groups (no sessions under the root)');
  return problems;
}

describe.runIf(live)('live index (PITWALL_LIVE=1, read-only)', () => {
  it('builds a well-formed snapshot from the real sessions, twice', async () => {
    const indexer = startIndexer({ roots: [root], intervalMs: 1000 });
    try {
      const first = await new Promise<IndexSnapshot>((resolve) => indexer.subscribe(resolve));
      expect(await snapshotProblems(first)).toEqual([]);

      // Let the poller run again, so the incremental read path runs on real files.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const later = indexer.latest();
      expect(later).toBeDefined();
      expect(later && Date.parse(later.generatedAt) > Date.parse(first.generatedAt)).toBe(true);
      expect(later ? await snapshotProblems(later) : ['latest']).toEqual([]);
    } finally {
      indexer.stop();
    }
  }, 60_000);
});
