#!/usr/bin/env node
// Spike 018 probe (throwaway). Logs every hook input to $P018_LOG; denies SendMessage per $P018_DENY ({"mode":"json"|"exit2","match":"text"});
// probes the target sub-agent (meta "finished", task notifications, latest usage); injects additionalContext inside sub-agents.
// spike 018 logger: appends hook input (trimmed) to a fixed log; with MODE deny-finished denies SendMessage
import { appendFileSync, readFileSync } from 'node:fs';
const LOG = process.env.P018_LOG ?? new URL('../log.jsonl', import.meta.url).pathname;
let s = ''; process.stdin.setEncoding('utf8');
for await (const c of process.stdin) s += c;
let i; try { i = JSON.parse(s); } catch { process.exit(0); }
const ev = process.argv[2] || i.hook_event_name;
appendFileSync(LOG, JSON.stringify({ t: Date.now(), ev, input: i, env: { PITWALL_HOME: process.env.PITWALL_HOME, P018: process.env.P018 } }) + '\n');
let probe;
if (ev === 'PreToolUse' && i.tool_name === 'SendMessage') {
  try {
    const id = i.tool_input.to; const t = readFileSync(i.transcript_path, 'utf8');
    const dir = i.transcript_path.replace(/\.jsonl$/, '') + '/subagents/';
    const meta = JSON.parse(readFileSync(dir + 'agent-' + id + '.meta.json', 'utf8'));
    const sub = readFileSync(dir + 'agent-' + id + '.jsonl', 'utf8').trim().split('\n');
    const notes = [...t.matchAll(/<task-notification>\\n<task-id>([a-z0-9]+)<\/task-id>[\s\S]{0,400}?<status>([a-z_]+)<\/status>/g)].filter(m => m[1] === id).map(m => m[2]);
    const lastAssist = sub.map(l => JSON.parse(l)).filter(e => e.type === 'assistant').pop();
    const u = lastAssist?.message?.usage;
    probe = { metaFinished: meta.finished, notes, subLines: sub.length, ctx: u && (u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens), lastTs: lastAssist?.timestamp };
  } catch (e) { probe = { err: String(e) }; }
  appendFileSync(LOG, JSON.stringify({ t: Date.now(), ev: 'PROBE', probe }) + '\n');
}
if (ev === 'PostToolUse' && i.tool_name === 'SendMessage') {
  await new Promise(r => setTimeout(r, 3000));
  try {
    const id = i.tool_input.to; const dir = i.transcript_path.replace(/\.jsonl$/, '') + '/subagents/';
    const meta = JSON.parse(readFileSync(dir + 'agent-' + id + '.meta.json', 'utf8'));
    const sub = readFileSync(dir + 'agent-' + id + '.jsonl', 'utf8').trim().split('\n');
    appendFileSync(LOG, JSON.stringify({ t: Date.now(), ev: 'POSTPROBE', metaFinished: meta.finished, subLines: sub.length }) + '\n');
  } catch (e) { appendFileSync(LOG, JSON.stringify({ ev: 'POSTPROBE', err: String(e) }) + '\n'); }
}
const denyFile = process.env.P018_DENY ?? new URL('../deny.json', import.meta.url).pathname;
if (ev === 'PreToolUse' && i.tool_name === 'SendMessage') {
  let mode; try { mode = JSON.parse(readFileSync(denyFile, 'utf8')); } catch {}
  if (mode && mode.match && !String(i.tool_input.message).includes(mode.match)) mode = undefined;
  if (mode?.mode === 'json') { console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'SPIKE018 DENY-JSON: start a fresh Agent for new work.' } })); }
  if (mode?.mode === 'exit2') { console.error('SPIKE018 DENY-EXIT2: start a fresh Agent for new work.'); process.exit(2); }
}
if (['PreToolUse','PostToolUse'].includes(ev) && i.agent_id && process.env.P018_INJECT !== '0') {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: ev, additionalContext: 'SPIKE018 SUBAGENT NOTE: finish this piece now and report.' } }));
}
if (ev === 'SubagentStop' || ev==='Stop') { /* log only */ }
