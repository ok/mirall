import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { advertise, ownCatalogKeyHex } from '../../src/shared/shares/own-catalog.js'
import { initPendingTransfers, getPendingFor, recordPending, recordPendingError } from '../../src/shared/transfer/pending-transfers.js'
import { CODES } from '../../src/shared/contract/errors.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/overlay/overlay-download.js'
import { downloadChannel, requestShareDownload, requestShareDownloads, setDownloadEngine } from '../../src/shared/transfer/overlay/share-downloads.js'
import { looseShareFor } from '../../src/shared/transfer/overlay/download-job.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'
import { pinnedDest, resolveDest } from '../../src/shared/transfer/download-dest.js'
import { setSpaceDownloadRoot } from '../../src/shared/core/paths.js'

// A pending row records the folder it lands under and keeps it across a pause: a file under way, or
// one still waiting on its owner, resumes there whatever the space's folder is now, and follows the
// space only when its own folder cannot be reached. A file that failed before its first byte follows
// the space.

const OWNER = 'o'.repeat(64)
const HASH = 'a'.repeat(64)

// The owner's catalog read as a peer's, and an engine that records each job it is handed.
async function setup(t) {
  const ctx = await freshPeer(t)
  await initPendingTransfers()
  const { spaceId } = await createSpace('Aurora')
  const keyHex = await ownCatalogKeyHex(spaceId)
  const folder = { id: 'sh1', name: 'Vault', owner: OWNER, catalogKeyEnc: keyHex, catalogEpoch: 0 }
  const loose = looseShareFor({ publicKey: OWNER, looseCatalogKeyEnc: keyHex })
  await advertise(spaceId, 'sh1', 'sub/big.iso', { size: 4, mtime: 1, contentHash: HASH })
  await advertise(spaceId, LOOSE_SHARE_ID, 'a.bin', { size: 4, mtime: 1, contentHash: HASH })
  const started = []
  setDownloadEngine({
    start: async (job) => { started.push(job); return { transferId: job.transferId, finalPath: job.finalPath } },
    clearPauseMarker: () => {},
    reconcileOnAppend: async () => {},
    activeDests: () => [],
    destProbe: (dir) => ({ dirExists: () => fs.existsSync(dir) }),
  })
  t.teardown(() => setDownloadEngine(null))
  const own = ctx.tmpDir('dl-own')
  const spaceFolder = ctx.tmpDir('dl-space')
  setSpaceDownloadRoot(spaceId, spaceFolder)
  const pinned = path.join(own, 'Vault', 'sub', 'big.iso')
  const pause = (bytesTransferred) => recordPending(spaceId, '/Vault/sub/big.iso', {
    total: 4, ownerKey: OWNER, finalPath: pinned, destDir: own, contentHash: HASH, bytesTransferred,
    overlayShare: true, shareId: 'sh1', relPath: 'sub/big.iso', catalogKeyEnc: keyHex, catalogEpoch: 0, layout: 'tree',
  })
  const last = () => started[started.length - 1]
  return { ctx, spaceId, folder, loose, own, spaceFolder, pinned, pause, last }
}

test('a paused row resumes in its own folder after the space\'s folder changed', async (t) => {
  const s = await setup(t)
  await s.pause(2)
  await requestShareDownload(s.spaceId, s.folder, 'sub/big.iso')
  t.is(s.last().finalPath, s.pinned, 'the pin is kept')
  t.is(s.last().destRoot, s.own)
  t.is(s.last().prevBytes, 2, 'and so are its bytes')
})

test('a paused row asked for another folder still resumes in its own', async (t) => {
  const s = await setup(t)
  await s.pause(2)
  await requestShareDownload(s.spaceId, s.folder, 'sub/big.iso', { destDir: s.ctx.tmpDir('dl-asked') })
  t.is(s.last().finalPath, s.pinned)
})

test('a row that has not started lands in the folder it is asked for', async (t) => {
  const s = await setup(t)
  await s.pause(0)
  const asked = s.ctx.tmpDir('dl-asked')
  await requestShareDownload(s.spaceId, s.folder, 'sub/big.iso', { destDir: asked })
  t.is(s.last().finalPath, path.join(asked, 'Vault', 'sub', 'big.iso'))
  t.is(s.last().destRoot, asked)
})

test('a row that has neither started nor failed keeps its own folder', async (t) => {
  const s = await setup(t)
  await s.pause(0)
  await requestShareDownload(s.spaceId, s.folder, 'sub/big.iso')
  t.is(s.last().finalPath, s.pinned, 'a waiting file resumes where it was headed')
  t.is(s.last().destRoot, s.own)
})

test('REGRESSION (FIX-DLTO-R11: a Retry of a download refused before its first byte returns to the folder that refused it)', async (t) => {
  const s = await setup(t)
  await s.pause(0)
  await recordPendingError(s.spaceId, '/Vault/sub/big.iso', CODES.TRANSFER_DISK_FULL, { refusedByPreflight: true })
  await requestShareDownload(s.spaceId, s.folder, 'sub/big.iso')
  t.is(s.last().destRoot, s.spaceFolder, 'Retry acts in the space\'s current folder')
  t.is(s.last().finalPath, path.join(s.spaceFolder, 'Vault', 'sub', 'big.iso'))
})

test('a row whose own folder is gone follows the space, avoiding a file already there', async (t) => {
  const s = await setup(t)
  await s.pause(2)
  fs.rmSync(s.own, { recursive: true, force: true })
  fs.mkdirSync(path.join(s.spaceFolder, 'Vault', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(s.spaceFolder, 'Vault', 'sub', 'big.iso'), 'someone else')
  await requestShareDownload(s.spaceId, s.folder, 'sub/big.iso')
  t.is(s.last().finalPath, path.join(s.spaceFolder, 'Vault', 'sub', 'big (1).iso'))
  t.is(s.last().destRoot, s.spaceFolder)
  t.is(s.last().prevBytes, 0, 'the old partial is given up')
})

test('a click on one folder file keeps its subfolder; a loose file lands flat', async (t) => {
  const s = await setup(t)
  const asked = s.ctx.tmpDir('dl-asked')
  await requestShareDownload(s.spaceId, s.folder, 'sub/big.iso', { destDir: asked })
  t.is(s.last().finalPath, path.join(asked, 'Vault', 'sub', 'big.iso'))
  await requestShareDownload(s.spaceId, s.loose, 'a.bin', { destDir: asked })
  t.is(s.last().finalPath, path.join(asked, 'a.bin'))
  await requestShareDownload(s.spaceId, s.loose, 'a.bin')
  t.is(s.last().finalPath, path.join(s.spaceFolder, 'a.bin'), 'nothing asked: the space\'s folder')
})

// The Windows path rules, applied on any host: share-downloads asks bare-os for the platform at
// call time, so pinning its answer is what a Windows host would see.
function pinWindows(t) {
  const real = os.platform
  os.platform = () => 'win32'
  t.teardown(() => { os.platform = real })
}

// Each case names a folder or subfolder Windows cannot hold; the leaf names are distinct, so each
// click's flat landing is its own.
const WINDOWS_ILLEGAL = [
  ['CON', 'con-readme.txt'], ['aux', 'aux-readme.txt'], ['Draft.', 'draft.txt'],
  ['Clients', 'Final?/notes.txt'], ['Clients', 'v2./b.txt'], ['Clients', 'Invoices 10:2026/a.pdf'],
]

test('REGRESSION (FIX-DLTO-R7: a click on a folder file whose folder path Windows cannot hold is refused)', async (t) => {
  const ctx = await freshPeer(t)
  await initPendingTransfers()
  const { spaceId } = await createSpace('Aurora')
  const keyHex = await ownCatalogKeyHex(spaceId)
  setSpaceDownloadRoot(spaceId, ctx.tmpDir('dl-space'))
  // The owner is away, so each start writes its row and parks.
  setDownloadEngine(createOverlayDownloadEngine({ ...downloadChannel, isOwnerOnline: () => false }))
  t.teardown(() => setDownloadEngine(null))
  const asked = ctx.tmpDir('dl-asked')
  const shareNamed = (name) => ({ id: 'sh-' + name.replace(/\W/g, ''), name, owner: OWNER, catalogKeyEnc: keyHex, catalogEpoch: 0 })
  for (const [name, relPath] of WINDOWS_ILLEGAL) await advertise(spaceId, shareNamed(name).id, relPath, { size: 4, mtime: 1, contentHash: HASH })
  await advertise(spaceId, shareNamed('Clients').id, 'Final?/other.txt', { size: 4, mtime: 1, contentHash: HASH })
  pinWindows(t)

  for (const [name, relPath] of WINDOWS_ILLEGAL) {
    const res = await requestShareDownload(spaceId, shareNamed(name), relPath, { destDir: asked }).catch((err) => err)
    t.absent(res instanceof Error, `${name}/${relPath}: the click is answered (${res?.code ?? 'queued'})`)
    const row = await getPendingFor(spaceId, '/' + name + '/' + relPath)
    t.is(row?.finalPath, path.join(asked, path.basename(relPath)), `${name}/${relPath}: lands flat by its name`)
    t.absent(row?.layout, `${name}/${relPath}: and its row records no tree to resume into`)
  }
  const batch = await requestShareDownloads(spaceId, shareNamed('Clients'), ['Final?/other.txt'], { destDir: asked })
  t.is(batch.failed, 1, 'a batch refuses such a file rather than scatter it flat')
})

test('no pin at all resolves fresh', async (t) => {
  const { downloads } = await freshPeer(t)
  t.is(pinnedDest(undefined, downloads), null)
  t.is(pinnedDest(null, downloads), null)
  t.is(pinnedDest(path.join(downloads, 'a.txt'), path.join(downloads, 'other')), null, 'a pin outside the folder is not kept')
  t.is(resolveDest(downloads, 'a.txt'), path.join(downloads, 'a.txt'))
})

test('REGRESSION (MIR-13): a pin a file now sits at is re-resolved, never written over', async (t) => {
  const { downloads } = await freshPeer(t)
  const pinned = path.join(downloads, 'big.iso')
  fs.writeFileSync(pinned, 'saved here while the download was paused')

  const dest = pinnedDest(pinned, downloads) ?? resolveDest(downloads, 'big.iso')
  t.is(dest, path.join(downloads, 'big (1).iso'), 'a free sibling instead of the occupied pin')
})
