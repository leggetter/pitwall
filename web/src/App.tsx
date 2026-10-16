import { WS_PATH, type IndexSnapshot } from '../../src/shared/protocol.js';

// W1 placeholder, replaced by W4. It imports a type and a value from the shared
// contract to prove the web build can reach src/shared.
export function App({ snapshot }: { snapshot?: IndexSnapshot }) {
  return (
    <main>
      <h1>pitwall</h1>
      <p>{snapshot ? `${snapshot.groups.length} groups` : `Not connected to ${WS_PATH} yet.`}</p>
    </main>
  );
}
