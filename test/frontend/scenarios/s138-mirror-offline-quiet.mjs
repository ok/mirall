import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// FIX-MIRROR-OFFLINE — a mirrored folder whose owner is offline must be QUIET. Before the fix the
// worker walked the catalog every tick and marked each file in turn as downloading, which the row
// view paints as a rotating "Preparing…" badge — directly under a banner saying the owner is
// offline.
//
// The mirror is mounted AFTER the owner quits, which is the reported shape and the ONLY one that
// reproduces. Mirroring first and then deleting the files does not: a completed fetch registers the
// blob in Bob's own overlay spool, so the re-fetch is answered from local disk with no peer at all
// and the mirror converges instead of spinning. Bob must never have held this content.
//
// TWELVE files, not two: a pass turns continuous only once it outlasts its own 30s poll, which at
// the vendor's 3s peer wait means ten or more missing files. Below that the spin is a burst every
// 30s and the badge is easy to miss.
//
// Steps are deliberately fine-grained: makeReport prints nothing until the run ends, so a coarse
// scenario is indistinguishable from a hang while it is working.
const NAMES = Array.from({ length: 12 }, (_, i) => `track-${String(i + 1).padStart(2, '0')}.txt`)

export default async function s138 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Set')
  mkdirSync(ownDir, { recursive: true })
  for (const n of NAMES) writeFileSync(path.join(ownDir, n), 'x'.repeat(64))
  const mirrorDir = workDir('mirror-')

  try {
    await r.ok('launch + connect', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
    })

    await r.ok('A shares "Set" and B sees it', async () => {
      await A.addOwnedFolder(ownDir)
      await B.waitText('Set', 60000)
    })

    // Browsing is what pulls Alice's catalog onto Bob's disk. Without it Bob would have no rows to
    // render once she is gone, and the folder would be quiet for the wrong reason entirely.
    await r.ok('B browses the folder so the catalog replicates', async () => {
      await B.openFolder('Set')
      await B.waitText(NAMES[0], 60000)
    })

    // Killed while Bob is INSIDE the folder, which is where the offline copy is known to render
    // (s41 pins exactly this wait). Hard-kill detection rides swarm keepalive — tens of seconds.
    await r.ok('Alice goes offline and Bob notices', async () => {
      await A.kill()
      await B.waitText('offline', 90000)
      await B.click({ name: 'Back' })
      await B.waitText('Set', 30000)
    })

    // The mount itself is the subject: this runs the initial materialize scan, which is the path
    // with no tick-level gate above it.
    await r.ok('B mirrors the folder while its owner is away', async () => {
      await B.mirrorShare(mirrorDir)
      await B.openFolder('Set')
      await waitFor(() => B.hasText('Not available'), 60000, 'rows render as Not available')
    })

    await r.ok('the folder stays quiet — no rotating "Preparing…" badge', async () => {
      // hasText is a case-folded WHOLE-WINDOW substring match, so this asserts "Preparing" appears
      // nowhere on screen. Sample faster than the 3s peer wait or a spinning badge hides between
      // samples, and for longer than one 30s poll so a tick is covered as well as the initial scan.
      // A transient AX read is "not yet", not a failure — waitText polls through those and a raw
      // hasText loop must too, or a repaint mid-sample fails the scenario for the wrong reason.
      const deadline = Date.now() + 40000
      let sawPreparing = false
      while (Date.now() < deadline && !sawPreparing) {
        try { sawPreparing = await B.hasText('Preparing') } catch { /* transient AX — retry */ }
        await new Promise((res) => setTimeout(res, 500))
      }
      assert(!sawPreparing, 'no rotating "Preparing…" badge while the owner is offline')
      assert(await B.hasText('Not available'), 'and the rows still read Not available')
      await B.shot('s138-B-mirror-quiet-offline', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
