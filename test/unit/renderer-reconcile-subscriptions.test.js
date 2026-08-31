import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

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
