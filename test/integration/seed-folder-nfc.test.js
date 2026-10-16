import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { freshPeer } from '../helpers/store.js'
import { createSpace, joinSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { getSpace } from '../../src/shared/spaces/space.js'
import { getNewSpaceDownloadDir } from '../../src/shared/core/paths.js'
import { setDownloadFolder } from '../../src/shared/core/runtime-config.js'

// REGRESSION (FIX-DLTO-R17: macOS hands a folder name back decomposed (NFD) where it was created
// through Foundation or Finder, while every folder the app stores is composed (NFC). A legacy NFD app
// folder seeded spaces raw, so the first pick of the same folder read as a move, with a spurious
// toast and the folder listed twice in the Download-to menu.)
test('REGRESSION (FIX-DLTO-R17: an NFD app folder seeds new spaces with the NFC spelling)', async (t) => {
  if (os.platform() !== 'darwin') { t.pass('darwin-only: other hosts keep a name as it was written'); return }
  const { tmpDir } = await freshPeer(t)
  const composed = path.join(tmpDir('dl'), 'Bücher')
  fs.mkdirSync(composed)
  const decomposed = composed.normalize('NFD')
  t.not(decomposed, composed, 'precondition: two spellings of one folder')
  setDownloadFolder(decomposed)

  t.is(getNewSpaceDownloadDir(), composed, 'the seed is answered in the spelling stored folders use')
  const created = await createSpace('Nord')
  t.is((await getSpace(created.spaceId)).downloadFolder, composed, 'a created space stores it')
  const joined = await joinSpace(crypto.randomBytes(32).toString('hex'), 'Joined')
  t.is((await getSpace(joined.spaceId)).downloadFolder, composed, 'and so does a joined one')
})
