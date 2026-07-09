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
  for (const [file, events] of Object.entries(banned)) {
    const src = hookSrc(file)
    t.ok(subscribes(src, 'event:reconcile'), `${file} consumes event:reconcile`)
    for (const e of events) t.absent(subscribes(src, e), `${file} no longer subscribes ${e}`)
  }
})
