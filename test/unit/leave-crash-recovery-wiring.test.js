import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

// The boot wiring itself isn't importable (src/worker/main.js runs top to bottom under Bare),
// so pin the structural invariants source-side, like worker-epipe-guard.test.js does: boot must
// complete interrupted leaves BEFORE the membership backfill and exclude them from it, and the
// teardown must persist the leaving marker before the member del.

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, '..', '..', 'src', 'worker', 'main.js'), 'utf8')

test('G4 wiring: boot completes interrupted leaves and excludes them from membership/topic setup', (t) => {
  // Anchor on the CALL (`await …`), never the bare symbol: the import line would otherwise
  // satisfy any "resume precedes X" ordering check regardless of where the call actually sits.
  t.ok(/await resumeInterruptedLeave\(/.test(src), 'boot calls resumeInterruptedLeave')
  t.ok(/const activeSpaces = knownSpaces\.filter\(\(s\) => !s\.leaving\)/.test(src), 'boot derives activeSpaces excluding leaving spaces')
  const resumeBeforeMark = src.match(/await resumeInterruptedLeave\([\s\S]*?for \(const space of activeSpaces\)[\s\S]{0,200}?markOwnMembership/)
  t.ok(resumeBeforeMark, 'completion pass (the call) precedes a markOwnMembership loop over activeSpaces')
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
  const ordered = src.match(/tracker\.phase = 'mark-leaving'[\s\S]*?markSpaceLeavingDurable[\s\S]*?tracker\.phase = 'clearOwnMembership'/)
  t.ok(ordered, 'markSpaceLeavingDurable phase precedes the clearOwnMembership phase')
})
