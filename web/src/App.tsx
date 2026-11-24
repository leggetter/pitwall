import { lazy, useEffect, useMemo } from 'react';
import { ApiContext, createApiClient, defaultFetch, type FetchLike } from './api.js';
import { AttachContext, type AttachEnv } from './attach.js';
import { Dashboard } from './components/Dashboard.js';
import { AskingNotice, NoTokenNotice, TokenRejectedNotice } from './components/Notice.js';
import { defaultSocketFactory, useConnection, type SocketFactory } from './connection.js';
import { DefaultEditorContext, EditorsContext, useEditorList } from './editors.js';
import { useToken } from './token.js';
import { answerLinkRequests, defaultChannel, LinkConfirmer, useLinkedToken, type ChannelFactory } from './tokenLink.js';
import { UikitRoute } from './uikit/route.js';

export interface AppProps {
  /** Opens the WebSocket. Tests pass a fake; the browser's `WebSocket` otherwise. */
  createSocket?: SocketFactory;
  /** Makes API requests. Tests pass a fake; the browser's `fetch` otherwise. */
  fetch?: FetchLike;
  /** The BroadcastChannel for links opened in new tabs (W175). Tests pass a fake, or undefined for none; the browser's otherwise. */
  linkChannel?: ChannelFactory | undefined;
}

/**
 * The design system's gallery (W19, docs/design-system.md), shown at #uikit. Only in dev builds:
 * `npm run dev` builds in Vite's development mode, and the tests run in its test mode. `npm run
 * build` is the production mode, where this is null, so the build leaves out the route, the
 * gallery, its fixtures and its stylesheet.
 */
const Gallery =
  import.meta.env.MODE === 'development' || import.meta.env.MODE === 'test' ? lazy(() => import('./uikit/Gallery.js')) : null;

function Connected({ token, createSocket, fetch, linkChannel }: { token: string; createSocket: SocketFactory; fetch: FetchLike; linkChannel: ChannelFactory | undefined }) {
  // One API client per token. It holds the apiKey in memory only, and the
  // connection hands it a fresh key on every handshake.
  const api = useMemo(() => createApiClient({ fetch }), [fetch]);
  // Answers other tabs' requests for the token (W175), but only after this server confirms their code
  // over this tab's signed-in socket.
  const links = useMemo(() => new LinkConfirmer(), []);
  const view = useConnection(token, { createSocket, keys: api.keys, links });
  useEffect(() => answerLinkRequests({ token, confirmer: links, channel: linkChannel }), [token, links, linkChannel]);
  // The editors pitwall's server found (W72), fetched once, as soon as the connection has an apiKey.
  const { editors, defaultEditor } = useEditorList(api);
  // Attach sockets answer their own challenge with the same token (W10).
  const attach = useMemo<AttachEnv>(() => ({ token, createSocket, host: window.location.host }), [token, createSocket]);
  // Only a 4401 on the WebSocket means the token is no good. An HTTP 401 means
  // the apiKey is stale, after a server restart: the client reconnects for a
  // new one and retries, so it never shows this.
  if (view.state === 'unauthorized') return <TokenRejectedNotice />;
  return (
    <ApiContext.Provider value={api}>
      <AttachContext.Provider value={attach}>
        <EditorsContext.Provider value={editors}>
          <DefaultEditorContext.Provider value={defaultEditor}>
            <Dashboard view={view} />
          </DefaultEditorContext.Provider>
        </EditorsContext.Provider>
      </AttachContext.Provider>
    </ApiContext.Provider>
  );
}

function Main({ createSocket = defaultSocketFactory, fetch = defaultFetch, ...rest }: AppProps) {
  const linkChannel = 'linkChannel' in rest ? rest.linkChannel : defaultChannel;
  const fragmentToken = useToken();
  // A tab with no token asks the open pitwall tabs for it (W175), once, before it shows the notice.
  const linked = useLinkedToken(fragmentToken === null, linkChannel);
  const token = fragmentToken ?? linked.token;
  if (!token) return linked.asking ? <AskingNotice /> : <NoTokenNotice />;
  // Keyed by the token, so a new one starts afresh: a new connection and a new API client.
  return <Connected key={token} token={token} createSocket={createSocket} fetch={fetch} linkChannel={linkChannel} />;
}

export function App(props: AppProps) {
  // While the gallery shows, the app is unmounted: no token read, no WebSocket, no API call.
  if (Gallery) {
    return (
      <UikitRoute gallery={Gallery}>
        <Main {...props} />
      </UikitRoute>
    );
  }
  return <Main {...props} />;
}
