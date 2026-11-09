// The names pitwall's relay (D8) and its supervisor (D4) run under, as the web UI shows them: who a
// session's message to pitwall was addressed to (W46, W138). The server's RELAY_NAME
// (src/server/relayPrompt.ts) and SUPERVISOR_NAME (src/supervisor/prompt.ts) are the ones they run
// under; src/index/conversation.test.ts fails if they differ. No imports, so the server's typecheck
// can read it.

export const RELAY_SESSION_NAME = 'pitwall-relay';

export const SUPERVISOR_SESSION_NAME = 'pitwall-supervisor';
