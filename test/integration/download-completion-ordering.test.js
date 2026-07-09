import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import url from 'bare-url'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { initDownloads, markDownloaded, markVerified, isDownloadedFile, peerFileStatus } from '../../src/shared/transfer/files.js'
import { initPendingTransfers, recordPending, getPendingFor } from '../../src/shared/transfer/pending-transfers.js'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const engineSrc = fs.readFileSync(
  path.join(here, '..', '..', 'src', 'shared', 'transfer', 'backends', 'overlay', 'overlay-download.js'),
  'utf8',
)

// A crash between the completion writes must leave the file re-derivable as 'downloaded',
// never as 'remote' (which duplicates on re-download) — so the durable positive fact
// (markDownloaded/markVerified) has to land BEFORE the resume row is cleared. This pins
// the write order in the engine's done block structurally; the behavior half below pins
// the masking that makes a lingering pending row harmless.
test("REGRESSION (FIX-D2: completion records the durable downloaded fact before clearing the resume row)", (t) => {
  const done = engineSrc.indexOf("diag.finish('done')")
  t.ok(done > -1, 'completion block found')
  const block = engineSrc.slice(done, engineSrc.indexOf('emitComplete', done))
  const downloadedAt = block.indexOf('markDownloaded')
  const verifiedAt = block.indexOf('markVerified')
  const clearAt = block.indexOf('clearPending')
  t.ok(downloadedAt > -1 && verifiedAt > -1 && clearAt > -1, 'all three completion writes present')
  t.ok(downloadedAt < clearAt, 'markDownloaded runs before clearPending')
  t.ok(verifiedAt < clearAt, 'markVerified runs before clearPending')
})

test('a pending row lingering after markDownloaded is masked by the downloaded status', async (t) => {
  const { tmpDir } = await freshPeer(t)
  await initDownloads()
  await initPendingTransfers()
  const space = await createSpace('Aurora')
  const spaceId = space.spaceId

  const landed = path.join(tmpDir('dl-landed'), 'report.pdf')
  fs.writeFileSync(landed, 'downloaded bytes')
  const drivePath = '/report.pdf'

  await recordPending(spaceId, drivePath, { finalPath: landed, bytesTransferred: 16, ownerKey: 'o'.repeat(64) })
  await markDownloaded(spaceId, drivePath, landed, { hash: 'h'.repeat(64) })
  await markVerified(spaceId, 'loose|report.pdf', 'h'.repeat(64))

  const downloaded = await isDownloadedFile(spaceId, drivePath, 'h'.repeat(64))
  const pendingRow = await getPendingFor(spaceId, drivePath)
  t.ok(downloaded, 'downloaded fact recorded and file on disk')
  t.ok(pendingRow, 'the resume row lingers (crash window)')
  t.is(peerFileStatus(downloaded, pendingRow, true, false), 'downloaded',
    'status derives downloaded, not paused/error, while the stale row lingers')
})
