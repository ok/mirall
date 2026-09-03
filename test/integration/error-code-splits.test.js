import test from 'brittle'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { ErrorCodes } from '../../src/shared/core/errors.js'
import { relocateForeignFolder, setForeignEnabled } from '../../src/shared/folders/foreign-folders.js'
import { revealLocalPath, addFile } from '../../src/shared/transfer/files.js'

// REGRESSION (FIX-CODES-2). These handler paths all threw NOT_FOUND — one code shared by 27 sites
// carrying 13 distinct meanings, which the renderer mapped to a single sentence ("Choose a folder
// to share."). A code per meaning is what makes a correct message possible at all.

async function codeOf (fn) {
  try {
    await fn()
    return null
  } catch (err) {
    return err.code
  }
}

test('a mirror verb on a mount that is not here reports MOUNT_NOT_ON_DEVICE', async (t) => {
  await freshPeer(t)
  const dest = path.join('/tmp', 'nowhere')
  t.is(await codeOf(() => relocateForeignFolder('space1', 'share1', dest)), ErrorCodes.MOUNT_NOT_ON_DEVICE)
  t.is(await codeOf(() => setForeignEnabled('space1', 'share1', false)), ErrorCodes.MOUNT_NOT_ON_DEVICE)
})

test('revealing a file that is not on disk reports FILE_NOT_ON_DEVICE', async (t) => {
  await freshPeer(t)
  const missing = path.join('/tmp', 'no-such-dir-' + Date.now(), 'file.txt')
  t.is(await codeOf(() => revealLocalPath(missing)), ErrorCodes.FILE_NOT_ON_DEVICE)
})

test('adding a file to a space with no drive reports DRIVE_NOT_FOUND', async (t) => {
  const ctx = await freshPeer(t)
  const src = path.join(ctx.tmpDir('src'), 'a.txt')
  t.is(await codeOf(() => addFile('no-such-space', src, 'a.txt')), ErrorCodes.DRIVE_NOT_FOUND)
})
