import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = (rel) => readFileSync(path.join(here, '..', '..', 'src', rel), 'utf8')
const workerMain = src('worker/main.js')
// The boot sequence and the mount runtime moved out of the entry into the composition root and
// worker/mounts-runtime.js, and the space:leave teardown into worker/ipc/space-leave.js; the
// invariants below are unchanged, only the file that carries them.
const boot = src('worker/boot.js')
const mountsRuntime = src('worker/mounts-runtime.js')
const swarm = src('shared/transfer/swarm.js')
const spaceLeave = src('worker/ipc/space-leave.js')

// These pin worker-orchestration fixes from the state-conveyance code review that can't be driven
// at the unit layer (they need the live swarm/DHT); the behavioral halves live in test/flow.

test('REGRESSION (C1: the re-grant honors the creator-divergence pause)', (t) => {
  const grant = workerMain.slice(workerMain.indexOf('const grant = () => {'))
  const body = grant.slice(0, grant.indexOf('\n  }'))
  t.ok(/creatorDivergence/.test(body) && body.indexOf('creatorDivergence') < body.indexOf('sendMembershipGrant'),
    'grant() checks creatorDivergence before sendMembershipGrant')
})

test('REGRESSION (C2: the offline-deny re-send excludes a knock backed by a valid invite)', (t) => {
  t.ok(/!hadLeft && !inviteRec && isDeniedJoiner/.test(workerMain),
    'the re-deny gate is skipped when a resolved invite record backs the knock')
})

test('REGRESSION (FIX-6/7/8: scan outcomes drive owned status; probe never blanket-writes active)', (t) => {
  t.ok(/async settleScanStatus\(/.test(mountsRuntime), 'the settleScanStatus method exists')
  t.ok(/result\?\.skipped === 'mount-point-gone'/.test(mountsRuntime) && /else if \(result\?\.skipped\)/.test(mountsRuntime),
    'a skipped scan is not recorded as active')
  // The probe's owned branch must not assert a durable status purely from path presence.
  t.absent(/setOwnedStatus\(mount\.spaceId, mount\.shareId, exists \? 'active'/.test(mountsRuntime),
    'the probe no longer blanket-writes active/gone from path presence')
})

test('REGRESSION (FIX-16: boot drops a pending-leave marker whose space record still exists)', (t) => {
  t.ok(/if \(!pl\.topic \|\| await getSpace\(pl\.spaceId\)\) \{ await clearPendingLeave/.test(boot),
    'the boot replay skips + clears a marker for a still-live space')
})

test('REGRESSION (FIX-17: space:join retires a pending leave only when one is armed)', (t) => {
  t.ok(/if \(hasPendingLeave\(rejoinSpaceId\)\) \{/.test(workerMain),
    'the marker teardown is guarded by hasPendingLeave so it never tears down a live topic')
})

test('REGRESSION (FIX-18: a handshake for a space with no local record is rejected)', (t) => {
  // Anchor inside handleHandshake (unique log line) and check the null-space guard precedes admit.
  const h = swarm.slice(swarm.indexOf('handshake topic not matched locally'))
  const admitAt = h.indexOf('admitMember')
  t.not(admitAt, -1, 'the admit gate is still named admitMember (a rename would make this vacuous)')
  const beforeAdmit = h.slice(0, admitAt)
  t.ok(/if \(!space\) \{/.test(beforeAdmit), 'handleHandshake returns early on a null space before the admit gate')
})

test('REGRESSION (FIX-19: the post-teardown topic rejoin re-checks the live marker)', (t) => {
  t.ok(/function rejoinPendingLeaveTopicAfterTeardown\(spaceId, space\) \{\s*\n\s*if \(!hasPendingLeave\(spaceId\)/.test(spaceLeave),
    'rejoin gates on hasPendingLeave, not a stale armed flag')
})

test('REGRESSION (FIX-21: an enabled foreign mirror missing at boot is durably paused)', (t) => {
  t.ok(/if \(!mountRootAvailable\(mount\.mountPath\)\) \{\s*\n\s*await autoPauseForeignMountGone/.test(mountsRuntime),
    'the foreign boot loop pauses a gone-at-boot enabled mirror')
})

test('REGRESSION (FIX-E1: the pending-leave marker arms on any unacked member, not a vacuous bool)', (t) => {
  const fn = spaceLeave.slice(spaceLeave.indexOf('async function armPendingLeaveIfUnwitnessed'))
  const body = fn.slice(0, fn.indexOf('\n}'))
  t.ok(/others\.length === 0\) return false/.test(body), 'a solo space (no other members) never arms a marker')
  t.ok(/others\.every\(\(k\) => acked\.has\(k\)\) \) return false|others\.every\(\(k\) => acked\.has\(k\)\)\) return false/.test(body.replace(/\s+/g, ' ')) || /every\(\(k\) => acked\.has\(k\)\)/.test(body),
    'arms unless every other member acked')
})
