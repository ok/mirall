import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { revealTarget, revealFile } from '../../src/shared/transfer/reveal.js'
import { markDownloaded } from '../../src/shared/transfer/files.js'
import { getDownloadDir } from '../../src/shared/core/paths.js'
import { CODES } from '../../src/shared/contract/errors.js'

// A headless daemon has nothing to open a file manager on, so a reveal ANSWERS instead of acting:
// the path on this device, whether it is there, and whose device that is.

async function codeOf(fn) {
  try { await fn(); return null } catch (err) { return err.code }
}

const spaceId = 's'.repeat(16)

test('an existing target is answered as the daemon’s, present', async (t) => {
  await freshPeer(t)
  const landed = path.join(getDownloadDir(spaceId), 'present.bin')
  fs.writeFileSync(landed, 'x')
  t.teardown(() => { try { fs.rmSync(landed, { force: true }) } catch {} })
  t.alike(revealTarget(landed), { path: landed, exists: true, host: 'daemon' })
})

test('a missing file whose folder exists is answered absent, with the same path', async (t) => {
  await freshPeer(t)
  const gone = path.join(getDownloadDir(spaceId), 'gone.bin')
  t.alike(revealTarget(gone), { path: gone, exists: false, host: 'daemon' },
    'the client shows the folder; the path still names the file')
})

test('a target with neither file nor folder is an error, never an answer', async (t) => {
  await freshPeer(t)
  const missing = path.join('/tmp', 'no-such-dir-' + Date.now(), 'file.txt')
  t.is(await codeOf(() => revealTarget(missing)), CODES.FILE_NOT_ON_DEVICE)
})

// A folder that is now a regular file is not a folder the client may be sent to show.
test('a parent that is a file is no folder', async (t) => {
  await freshPeer(t)
  const notAFolder = path.join(getDownloadDir(spaceId), 'was-a-folder')
  fs.writeFileSync(notAFolder, 'x')
  t.teardown(() => { try { fs.rmSync(notAFolder, { force: true }) } catch {} })
  t.is(await codeOf(() => revealTarget(path.join(notAFolder, 'file.txt'))), CODES.FILE_NOT_ON_DEVICE)
})

// The folder case has no stand-in the client may open: a mount root's parent is outside every
// allowlisted root. So a missing folder is the folder's own error, not an "absent" answer.
test('a folder reveal requires the folder itself', async (t) => {
  await freshPeer(t)
  const parent = path.join('/tmp', 'reveal-parent-' + Date.now())
  fs.mkdirSync(parent)
  t.teardown(() => { try { fs.rmSync(parent, { recursive: true, force: true }) } catch {} })
  const goneMount = path.join(parent, 'mount')
  const folderOpts = { missingCode: CODES.MOUNT_NOT_ON_DEVICE, requireSelf: true }
  t.is(await codeOf(() => revealTarget(goneMount, folderOpts)), CODES.MOUNT_NOT_ON_DEVICE)
  fs.mkdirSync(goneMount)
  t.alike(revealTarget(goneMount, folderOpts), { path: goneMount, exists: true, host: 'daemon' })
})

test('revealFile answers the downloaded copy’s real landing path', async (t) => {
  await freshPeer(t)
  const landed = path.join(getDownloadDir(spaceId), 'report (2).pdf')
  fs.writeFileSync(landed, 'x')
  t.teardown(() => { try { fs.rmSync(landed, { force: true }) } catch {} })
  await markDownloaded(spaceId, '/report.pdf', landed, { hash: 'h'.repeat(64) })
  t.alike(await revealFile(spaceId, '/report.pdf'), { path: landed, exists: true, host: 'daemon' })
})
