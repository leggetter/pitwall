// The name pitwall's relay runs under (D8), as the web UI shows it: who a session's message to pitwall
// was addressed to (W46). The server's RELAY_NAME (src/server/relayPrompt.ts) is the one the relay
// runs under; src/index/conversation.test.ts fails if the two differ. No imports, so the server's
// typecheck can read it.

export const RELAY_SESSION_NAME = 'pitwall-relay';
