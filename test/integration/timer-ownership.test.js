import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { trackTimers } from '../helpers/timers.js'

// The shim must wrap the globals BEFORE the modules load, so everything under test comes in through
// a dynamic import (static ones are hoisted above it). Installed once for the file and restored
// from the LAST test only: a per-test restore puts the natives back before the next test runs, and
// every assertion after that reads a map nothing writes to any more.
const timers = trackTimers()
const { freshPeer } = await import('../helpers/store.js')
const { createSpace } = await import('../../src/shared/spaces/space.js')
const { publishShare, generateShareId } = await import('../../src/shared/shares/shares.js')
const { getLocalPublicKeyHex } = await import('../../src/shared/spaces/profile.js')
const { createOwnedMount } = await import('../../src/shared/folders/mount-store.js')
const { onFsEvent } = await import('../../src/shared/folders/owned-folders.js')

async function ownedShare (ctx) {
  const space = await createSpace('Aurora')
  const share = {
    id: generateShareId(), type: 'owned-folder', name: 'Vault', contentMode: 'overlay',
    owner: getLocalPublicKeyHex(), createdAt: Date.now(),
  }
  await publishShare(space.spaceId, share)
  const mountPath = ctx.tmpDir('mount')
  await createOwnedMount({ spaceId: space.spaceId, shareId: share.id, mountPath, ignore: [], createdAt: Date.now() })
  return { space, share, mountPath }
}

// REGRESSION (ADOPT-B1: the owner's announce interval and its catch-up timeouts were held in
// module-scope bindings and armed from the global. _close cleared them by hand, which covers the
// ordinary ending and neither of the other two: ReadyResource finishes a FAILED _open by running
// close() WITHOUT ever calling _close, and a _close that rejects short-circuits the same way. Both
// left a periodic tick firing against a subsystem whose state had already been torn down. They now
// arm through the subsystem's own timer set, which the base clears on all three.)
//
// Counted as timeouts AND intervals: the catch-up reconcile is a timeout, so an intervals-only
// count — which is what the existing lifecycle guard takes — would report this file clean.
//
// One timeout is excluded, deliberately: the shutdown budget's own race in core/subsystem.js arms
// one per subsystem and does not clear it on the winning branch, so a fast close leaves the loser
// pending for the rest of the budget. It is unref'd and resolves a promise nobody is waiting on any
// more, and it CANNOT be owned — a shutdown deadline that shutdown itself cancels is not a
// deadline. Excluded by its arming site rather than by count, so a second un-owned timeout there
// would still be seen.

// The nearest frame below the shim, exactly as the tracker itself picks it — [1] is the shim's own
// wrapper, not the caller.
const armedBy = (e) => ((e.stack || '').split('\n').slice(1).find((l) => !l.includes('test/helpers/timers.js')) || '')
const notTheShutdownBudget = (list) => list.filter((e) => !/core[/\\]subsystem\.js/.test(armedBy(e)))

test('REGRESSION (ADOPT-B1): the owner side arms nothing a FAILING close can leave behind', async (t) => {
  t.teardown(() => timers.restore())
  const ctx = await freshPeer(t)
  const { space, share, mountPath } = await ownedShare(ctx)

  const abs = path.join(mountPath, 'a.txt')
  fs.writeFileSync(abs, 'x')
  await onFsEvent(space.spaceId, share.id, 'add', 'a.txt', abs)

  // Non-vacuous by construction: if nothing was armed, the assertion after close would pass no
  // matter what the subsystem did with its timers.
  const before = timers.intervals().length + notTheShutdownBudget(timers.timeouts()).length
  t.ok(before > 0, `the work under test armed something to begin with (${before})`)

  // The ordinary path already cleared these by hand and is not what this proves. A _close that
  // REJECTS short-circuits both `closed = true` and the 'close' emit, so every hand-written clear
  // after the throw is unreachable — the same reachability a failed _open has, and the only
  // difference between a timer the subsystem owns and one it merely remembers to stop. Rejecting
  // BEFORE the body rather than after is what makes the two designs distinguishable at all.
  const owned = ctx.root.ownedFolders
  owned._close = async () => { throw new Error('close failed before teardown ran') }
  // The composition root logs a failing close and carries on, so this does not reject.
  await ctx.root.close()

  const intervals = timers.intervals()
  const timeouts = notTheShutdownBudget(timers.timeouts())
  t.is(intervals.length, 0, 'no interval survived the failed close\n' + timers.describe(intervals))
  t.is(timeouts.length, 0, 'and no timeout either\n' + timers.describe(timeouts))
})
