import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { resolveRevealTarget } from '../../src/shared/transfer/reveal.js'
import { markDownloaded } from '../../src/shared/transfer/files.js'
import { getDownloadDir } from '../../src/shared/core/paths.js'

// The gate for routing a completed-download notification back through files:reveal instead of the
// client's own shell. That only works if the path the worker REVEALS is the path the event
// CARRIED — event:transfer-complete ships job.finalPath, while resolveRevealTarget re-derives from
// (spaceId, path). If those two ever disagree, the click opens the wrong file or nothing.
test('the reveal target is the path the completion event reported', async (t) => {
  const ctx = await freshPeer(t)
  const spaceId = 's'.repeat(16)
  const rendererPath = '/report.pdf'

  // A collision-avoiding landing path: NOT <Downloads>/<basename>, which is the case that would
  // hide a mismatch.
  const landed = path.join(getDownloadDir(spaceId), 'report (2).pdf')
  fs.writeFileSync(landed, 'x')
  t.teardown(() => { try { fs.rmSync(landed, { force: true }) } catch {} })

  await markDownloaded(spaceId, rendererPath, landed, { hash: 'h'.repeat(64) })

  t.is(await resolveRevealTarget(spaceId, rendererPath), landed,
    'files:reveal lands on the same file the event named, so the click can be routed to the daemon')
  t.ok(ctx)
})
