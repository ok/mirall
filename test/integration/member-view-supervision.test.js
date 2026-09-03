import test from 'brittle'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeerWithIdentity, offlineMemberRegistry } from '../helpers/store.js'
import { createSpace, pinCreatorKey } from '../../src/shared/spaces/space.js'
import { markOwnMembership } from '../../src/shared/spaces/profile.js'
import {
  MemberViews, openMemberView, closeMemberView, markLeft, isLeft,
} from '../../src/shared/spaces/member-registry.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { peerReadTimeoutMs } from '../../src/shared/core/with-timeout.js'

// The member fold walks the roster SERIALLY, one bounded peer read per member, so a space whose
// members are unreachable over the network freezes its member set, join requests and share list for
// the sum of those budgets with nothing reporting it.
//
// MEASURED, and it shapes this file: a fold with no REPLICATING peer settles immediately — an
// unknown roster key resolves to an empty local core and boundedUpdate returns at once, because
// there is no peer to wait for. A parked fold needs a peer that is connected and then silent, which
// no single-process test can produce. So the stalled/advancing/idle rule and the abandon-and-rearm
// behaviour are asserted directly on the primitive in test/unit/derived-view.test.js (red-first),
// and this file covers what only a real member view can show: the unit rows, and that the recovery
// touches the fold and nothing else.

const READ_BUDGET_MS = 30_000
const FOLD_WINDOW_MS = READ_BUDGET_MS * 20

const randomKey = () => b4a.toString(crypto.keyPair().publicKey, 'hex')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function spaceWithView (t) {
  await freshPeerWithIdentity(t)
  setRuntimeConfig({ ...getRuntimeConfig(), peerReadTimeoutMs: READ_BUDGET_MS })
  const { spaceId } = await createSpace('Aurora')
  await markOwnMembership(spaceId)
  await pinCreatorKey(spaceId, randomKey())
  await openMemberView(spaceId)
  t.teardown(() => closeMemberView(spaceId))
  const views = new MemberViews('member-views', { overlayBackend: {}, ...offlineMemberRegistry })
  await delay(50)
  return { spaceId, views }
}

test('every open view is one supervisable unit, keyed and labelled by its space', async (t) => {
  const { spaceId, views } = await spaceWithView(t)

  const rows = views.supervise({ now: Date.now() })
  t.is(rows.length, 1, 'one unit per open view')
  t.is(rows[0].key, spaceId)
  t.is(rows[0].label, spaceId, 'the log-safe label is the space id')
  t.is(rows[0].ok, true)

  t.is(views.supervise({ now: Date.now() + FOLD_WINDOW_MS + 1000 })[0].ok, true,
    'a view with no fold in flight is healthy however much time passes — idle is not stalled')

  await closeMemberView(spaceId)
  t.alike(views.supervise(), [], 'a closed view is no longer a unit')
})

// closeMemberView drops the in-memory leave tombstones and re-seeds only the DURABLE ones, so a
// leave frame whose persist failed would be forgotten and the leaver re-added by the next fold.
// The recovery must restart the fold and leave everything else alone.
test('REGRESSION (FIX-SUP-2: a recovery preserves a leave tombstone that never reached disk)', async (t) => {
  const { spaceId, views } = await spaceWithView(t)

  const leaver = randomKey()
  markLeft(spaceId, leaver, Date.now())
  t.ok(isLeft(spaceId, leaver), 'the leave frame was applied in memory')

  await views.recover(spaceId)
  await delay(50)
  t.ok(isLeft(spaceId, leaver), 'and it survived the recovery')
  t.is(views.supervise().length, 1, 'the view is still open — the recovery did not close it')

  await closeMemberView(spaceId)
  t.absent(isLeft(spaceId, leaver), 'closing the view is what drops it, which is why recovery must not close')
})

test('a recovery for a space with no open view is a no-op', async (t) => {
  await freshPeerWithIdentity(t)
  const views = new MemberViews('member-views', { overlayBackend: {}, ...offlineMemberRegistry })
  await views.recover('no-such-space')
  t.alike(views.supervise(), [], 'nothing to supervise, nothing to recover')
})

test('a stopping subsystem reports no units and recovers nothing', async (t) => {
  const { spaceId, views } = await spaceWithView(t)
  t.is(views.supervise().length, 1)

  views._stopping = true
  t.alike(views.supervise(), [], 'a teardown in progress reports nothing to recover')
  await views.recover(spaceId)
  t.pass('and the recovery is a no-op rather than a throw')
})

test('the fold window scales with the budget each roster read is capped at', (t) => {
  setRuntimeConfig({ ...getRuntimeConfig(), peerReadTimeoutMs: READ_BUDGET_MS })
  t.is(peerReadTimeoutMs(), READ_BUDGET_MS)
})

// The recovery route is the whole safety argument, and a future edit could quietly swap it for the
// obvious-looking close-and-reopen. Pinned by source text, the way the crash-backstop suite pins boot.js.
test('REGRESSION (FIX-SUP-2 wiring): the recovery restarts the fold and never closes the view', (t) => {
  const src = fs.readFileSync(path.join(
    path.dirname(import.meta.url.replace(/^file:\/\//, '')), '..', '..',
    'src', 'shared', 'spaces', 'member-registry.js'
  ), 'utf8')
  const body = src.slice(src.indexOf('async recover (spaceId)'))
  t.ok(/restartFold\?\.\(\)/.test(body), 'it re-arms the fold')
  t.absent(/closeMemberView|openMemberView/.test(body), 'and does not close or reopen the view')

  const view = fs.readFileSync(path.join(
    path.dirname(import.meta.url.replace(/^file:\/\//, '')), '..', '..',
    'src', 'shared', 'spaces', 'member-view.js'
  ), 'utf8')
  t.ok(/view\.noteProgress\(\)/.test(view), 'the fold reports a heartbeat per roster read')
  t.ok(/restartFold: \(\) => \{ view\.abandon\(\); view\.recompute\(\) \}/.test(view),
    'and the restart abandons the stalled fold rather than awaiting it')
})
