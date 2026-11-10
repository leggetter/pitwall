// pitwall's own `claude` processes, which the index leaves out of the list (src/cli.ts's exclude):
// the relay (D8), recap calls (W110), the supervisor (W113) and the Usage view's `/usage` call (W158,
// W157's rate-limits reader). Each knows its own by pid while it runs, by its folder and by its name.

import type { AgentRow } from '../index/agents.js';

export interface OwnSources {
  relay: { isRelay(row: AgentRow): boolean };
  recaps?: { isOwn(row: AgentRow): boolean } | undefined;
  supervisor?: { isOwn(row: AgentRow): boolean } | undefined;
  usage?: { isOwn(row: AgentRow): boolean } | undefined;
}

/** True for a row that is one of pitwall's own processes. */
export function isPitwallOwn(sources: OwnSources): (row: AgentRow) => boolean {
  return (row) =>
    sources.relay.isRelay(row) || sources.recaps?.isOwn(row) === true || sources.supervisor?.isOwn(row) === true || sources.usage?.isOwn(row) === true;
}
