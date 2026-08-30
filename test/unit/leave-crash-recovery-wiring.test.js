import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { LEAVE_PHASES } from '../../src/shared/spaces/leave-flow.js'

// The boot wiring isn't importable (it opens real cores under Bare), so pin the structural
// invariants source-side, like worker-epipe-guard.test.js does: boot must complete interrupted
// leaves BEFORE the membership backfill and exclude them from it, and the teardown must persist
// the leaving marker before the member del.
//
// The boot sequence lives in the composition root (src/worker/boot.js); the leave teardown moved
// out of the entry into src/worker/ipc/space-leave.js.

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, '..', '..', 'src', 'worker', 'boot.js'), 'utf8')
const entrySrc = readFileSync(path.join(here, '..', '..', 'src', 'worker', 'ipc', 'space-leave.js'), 'utf8')

test('G4 wiring: boot completes interrupted leaves and excludes them from membership/topic setup', (t) => {
  // Anchor on the CALL (`await …`), never the bare symbol: the import line would otherwise
  // satisfy any "resume precedes X" ordering check regardless of where the call actually sits.
  t.ok(/await resumeInterruptedLeave\(/.test(src), 'boot calls resumeInterruptedLeave')
  t.ok(/const activeSpaces = knownSpaces\.filter\(\(s\) => !s\.leaving\)/.test(src), 'boot derives activeSpaces excluding leaving spaces')
  // The ordering is now literal in the root's body: the resume pass, then the filter that drops
  // what it completed, then the backfill over what survived.
  const resumeBeforeMark = src.match(/await resumeInterruptedLeaves\(knownSpaces[\s\S]{0,900}?const activeSpaces = knownSpaces\.filter[\s\S]{0,900}?await backfillMembership\(activeSpaces/)
  t.ok(resumeBeforeMark, 'the completion pass precedes the membership backfill over activeSpaces')
  t.ok(/for \(const space of activeSpaces\)[\s\S]{0,120}?markOwnMembership/.test(src), 'the backfill loop iterates activeSpaces')
  t.ok(/for \(const space of activeSpaces\)[\s\S]{0,120}?joinSpaceTopic/.test(src), 'topic-join loop iterates activeSpaces')
  const rowCleanup = src.match(/await resumeInterruptedLeave\([\s\S]{0,600}?cleanupDownloadHistory[\s\S]{0,120}?clearPendingForSpace/)
  t.ok(rowCleanup, 'boot completion also purges the space download-history + pending-transfer rows')
  // A crash BEFORE the leave frame reached anyone must still announce the departure: the boot
  // loop arms the pending-leave replay before the resume deletes the record (which carries the
  // topic the replay needs).
  const replayArm = src.match(/persistPendingLeave\(space\.spaceId, space\.topic[\s\S]{0,400}?await resumeInterruptedLeave\(/)
  t.ok(replayArm, 'pending-leave replay armed before the resume deletes the record')
})

test('G4 wiring: teardown persists the durable marker before clearOwnMembership', (t) => {
  // The member del now runs as the first step of the shared teardown order, so the phase name is
  // stamped by leave-flow.js via onPhase rather than written inline. The invariant is unchanged:
  // the durable marker must be written before the departure it makes recoverable.
  const ordered = entrySrc.match(/tracker\.phase = 'mark-leaving'[\s\S]*?markSpaceLeavingDurable[\s\S]*?clearMembership:[\s\S]*?clearOwnMembership\(/)
  t.ok(ordered, 'markSpaceLeavingDurable precedes the member del')
  t.is(LEAVE_PHASES[0], 'clearOwnMembership', 'and the shared order still opens on that phase')
})
