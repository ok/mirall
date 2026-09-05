import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { Scope, scopeMatches } from '../../src/shared/contract/scope.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const hookSrc = (name) => readFileSync(path.join(here, '..', '..', 'src', 'renderer', 'hooks', name), 'utf8')

const subscribes = (src, eventName) => new RegExp(`subscribe(<[^>]*>)?\\(\\s*'${eventName}'`).test(src)

// The named *-updated events remain on the wire as poke sources (POKE_SCOPE fans them into
// event:reconcile), but the reconcile-driven hooks must not re-grow named subscriptions — that
// silently forks a view off the level-triggered channel and resurrects the missed-event class.
// Hooks only run inside Electron, so this pins the wiring structurally (the
// main-log-forwarding.test.js pattern).
test('reconcile-driven hooks subscribe the reconcile channel, not the named poke events', (t) => {
  const banned = {
    'useFiles.ts': ['event:files-updated'],
    'useShareFiles.ts': ['event:share-files-updated', 'event:files-updated', 'event:share-file-progress'],
    'useMembers.ts': ['event:members-updated', 'event:member-left', 'event:member-avatar-updated',
      'event:member-join-request', 'event:join-requests-updated'],
    'useShares.ts': ['event:shares-updated', 'event:foreign-folder-mount-status', 'event:owned-folder-mount-status'],
    // The two folder-status hooks. Both mount-status events map to the shares scope, so a named
    // subscription here is the same fork off the level-triggered channel the listing hooks were
    // moved away from — and it is how both of these carried a stale fault strip.
    'useFolderMount.ts': ['event:owned-folder-mount-status'],
    'useForeignMount.ts': ['event:foreign-folder-mount-status'],
    'useSpaces.ts': ['event:members-updated', 'event:member-left', 'event:member-avatar-updated',
      'event:member-join-request'],
    'useSpaceStorage.ts': ['event:share-files-updated', 'event:shares-updated'],
    'useSpaceMembers.ts': [],
  }
  // A hook re-derives from the reconcile CHANNEL, never from a named poke. It may reach that channel
  // two ways: its own subscription, or the query store, which holds one subscription for the whole
  // app and invalidates by scope. The named-poke ban is absolute either way.
  //
  // A store-backed hook must pass SCOPES, not merely call useQuery: the scopes argument defaults to
  // null and an entry with no scopes can never be matched by an invalidate, so a hook that omitted
  // it would satisfy a presence-only check while silently never re-deriving — the very failure this
  // test exists to catch.
  for (const [file, events] of Object.entries(banned)) {
    const src = hookSrc(file)
    const usesStore = /useQuery[<(]/.test(src)
    if (usesStore) {
      const scoped = /useQuery<[^>]*>\(\s*'[^']+',[^,]*,\s*[A-Za-z_[]/.test(src) || /kind: '/.test(src)
      t.ok(scoped, `${file} passes scopes to useQuery, so an invalidate can reach it`)
    } else {
      t.ok(subscribes(src, 'event:reconcile'), `${file} consumes event:reconcile`)
    }
    for (const e of events) t.absent(subscribes(src, e), `${file} no longer subscribes ${e}`)
  }
})

const rendererSrc = (...parts) => readFileSync(path.join(here, '..', '..', 'src', 'renderer', ...parts), 'utf8')

// REGRESSION (FIX-PEER-INFO-SCOPE: a view of a PEER's catalog pinned only the share-files scope.
// For a share this app neither owns nor mirrors, nothing local emits event:share-files-updated —
// the owner's append reaches us through ensurePeerCatalogWatch, which emits event:files-updated,
// i.e. the space-wide files scope. scopeMatches requires equal kinds, so the share-files-only view
// was never invalidated and its cached totals were frozen for the app session.)
test('REGRESSION (FIX-PEER-INFO-SCOPE): a peer-catalog view lists the files scope too', (t) => {
  const views = {
    'components/modals/MirrorFolderModal.tsx': 'share:folder-info',
    'hooks/useShareFiles.ts': 'share:list-files',
  }
  for (const [file, request] of Object.entries(views)) {
    const src = rendererSrc(...file.split('/'))
    t.ok(src.includes(request), `${file} still reads ${request}`)
    const shareScoped = /Scope\.shareFiles\(|kind: 'share-files'/.test(src)
    const spaceScoped = /Scope\.files\(|kind: 'files'/.test(src)
    t.ok(shareScoped, `${file} pins the share-files scope`)
    t.ok(spaceScoped, `${file} ALSO pins the space files scope — a peer append arrives on that one`)
  }
})

// The reason both are needed, asserted directly rather than left to the comment above.
test('a files hint cannot invalidate a share-files view', (t) => {
  t.absent(
    scopeMatches(Scope.files('sp1'), Scope.shareFiles('sp1', 'sh1')),
    'kinds must be equal — a space-wide files poke never reaches a share-files view',
  )
  t.ok(scopeMatches(Scope.files('sp1'), Scope.files('sp1')), 'while it does reach a files view')
})

// Every renderer file that WRITES the query store, with the reason it may. The rule this ratchets
// is about WHO holds the subscription, not about writing: a hook runs once per mounted consumer,
// so a worker event subscribed from inside one writes the same entry once per mount. Each write
// publishes a new object, which defeats the store's identity check and re-renders every subscriber
// again, and each event-driven refetch abandons the others' in-flight read.
const STORE_WRITERS = {
  'store/reconcile.ts': 'the app-wide push bridges — one subscription each, installed once in main.tsx',
  'hooks/useProfile.ts': 'post-mutation, so one call is one user action however many components are mounted',
  'screens/ActivityLogSettings.tsx': 'post-mutation, same reason',
}

function walkRenderer (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walkRenderer(p, out)
    else if (/\.(ts|tsx|js)$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

// REGRESSION (REVIEW-4: useDownloadRootStatus subscribed event:download-roots-status from inside the
// hook, and two components mount it — so one worker event wrote the entry twice. useSpaces was the
// worse twin: it pushed spaces:list from event:state and re-read on three membership events, with
// FIVE call sites and several mounted together, plus a mount-time refetchQuery that abandoned the
// read useQuery had just issued. Both moved to installPushBridges.)
test('REGRESSION (REVIEW-4): only the push bridges write the query store from a worker event', (t) => {
  const rendererRoot = path.join(here, '..', '..', 'src', 'renderer')
  const store = path.join(rendererRoot, 'store')
  const writers = walkRenderer(rendererRoot)
    // The store defines and declares it; the rule is about its CALLERS.
    .filter((f) => path.dirname(f) !== store || path.basename(f) !== 'query-store.js')
    .filter((f) => /setQueryData[<(]/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(rendererRoot, f).split(path.sep).join('/'))
    .sort()

  t.alike(writers, Object.keys(STORE_WRITERS).sort(),
    'a new store writer needs a reason in STORE_WRITERS — and if it writes from a subscription, it belongs in the bridge')
})

// REGRESSION (REVIEW-3: useQuery called useSyncExternalStore outside its enabled check, so a
// disabled consumer still subscribed the shared entry. invalidate() refetches any entry with a
// subscriber, so FolderView holding useOwnedMount for a MIRRORED share — enabled:false, projecting
// NO_OWNED_MOUNT whatever comes back — made every shares-scoped hint in any space issue a full
// owned-folder:list-all, which runs a live stat per owned mount, and then discarded the result.)
test('REGRESSION (REVIEW-3): a disabled useQuery holds no subscription on the shared entry', (t) => {
  const src = readFileSync(path.join(here, '..', '..', 'src', 'renderer', 'store', 'useQuery.ts'), 'utf8')
  t.ok(/enabled\s*\?\s*subscribeKey\(/.test(src),
    'the subscription is gated on enabled, so an entry nobody is really watching is left stale')
  t.ok(/enabled\s*\?\s*peek</.test(src),
    'and the snapshot is too — a disabled hook reads the empty snapshot, not another view\'s data')
})
