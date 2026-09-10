# Renderer hooks — the shared contracts

Every hook here reads through the query store (`../store/query-store.js`). Three rules apply to all
of them and are stated only here; a hook's own comment names its scopes and nothing more.

## `loading` means COLD, never "a read is in flight"

The store's `loading` is raised again on every refetch of a settled entry. A hook exposes `loading`
only while its entry has never answered — `data === undefined && fetching`, or the same test over
every entry it reads — so a hint-driven refetch keeps the rows, the scroll position and the
empty-state choice on screen instead of blinking a spinner. A boot or route gate asks "has an answer
landed?" (`data !== undefined || error != null`, see `../profileGate.js`), never the store flag:
gating a subtree on it is a remount loop.

## How a hook re-derives

A hook never subscribes to a worker event for shared state. It declares the scopes its entry
re-derives on — `useQuery(type, params, scopes)` — and `../store/reconcile.ts` holds the ONE
`event:reconcile` subscription for the app, invalidating every entry whose scopes match. The worker
decides which event maps to which scope: both mount-status events (owned and foreign) map to the
SHARES scope, not mirrors; a members change also re-derives loose files, because a peer's catalog
key commits post-handshake. A hook that lists a scope is trusting that mapping, not re-explaining
it. Events that carry a whole value are PUSHED into the entry by `installPushBridges`
(download-roots status, the spaces list); a hook reading such an entry passes `null` scopes and
must not subscribe — two mounts would double-write. An entry keeps the scopes it was FIRST
registered with, so shared scope constants live in `../store/scopes.ts`. Decoration events
(progress frames, index progress) carry no scope and are subscribed by name, for per-consumer
local state only.

## Identity-stable props for memoized rows

`SpaceView` and `FolderView` re-render once a second under the decoration heartbeat while any
transfer is live, and every row and tile is `memo`'d against that. The contract both sides keep:
every prop a row receives is a primitive, a row object reconciled for identity
(`../shareFilesReconcile.js`), a per-key value from a Map (decoration, download summary), or a
handler whose identity is stable across renders. A hook that hands a callback to rows wraps it in
`useCallback` over nothing but ids, or defines it at module level; a fresh closure per render makes
every row's shallow compare fail and repaints the whole list on each heartbeat.
