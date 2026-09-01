import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir, mkStoreDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const FLAGS = { overlayEnabled: true, inPlaceFilesEnabled: true }

// The leftover sweep runs on EVERY boot now, and it deletes any core it cannot place in the wanted
// set. A peer sharing only loose files publishes their catalog at loosecat*/<space> on their member
// record — not under share/<space>/, which is the only place the wanted set used to look. So a live
// peer's catalog was outside it, and the sweep would delete the listing on every launch while the
// peer was offline. This is the two-peer shape that produces a REAL replicated catalog; the
// single-peer test plants a synthetic one and never runs the scan at all.
test('a live peer’s loose catalog survives the boot sweep', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const bStore = mkStoreDir(t)
  const bFlags = { ...FLAGS, identityKEK: kekHex() } // stable across the relaunch
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkStoreDir(t), flags: FLAGS })
  let B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStore, downloads: mkTmpDir(t), flags: bFlags })
  const spaceId = await connectInSpace(t, A, B)

  // Loose, not a folder share: that is what puts the catalog key on the member record only.
  const src = path.join(mkTmpDir(t), 'note.bin')
  fs.writeFileSync(src, patternedBytes(32 * 1024, 5))
  await A.request('files:add', { spaceId, filePath: src, fileName: 'note.bin', fileSize: 32 * 1024 })
  await B.until('files:list', { spaceId },
    (f) => Array.isArray(f) && f.some((e) => e.path === '/note.bin'), { ms: 60000 })

  // Alice goes away, so nothing can re-replicate the catalog after the restart: if the sweep
  // deleted it, the listing is simply gone.
  const aPid = A.sidecar?._process?.pid
  A.kill()
  if (aPid) await waitForWorkerExit(aPid, 8000)

  const bPid = B.sidecar?._process?.pid
  B.kill()
  if (bPid) await waitForWorkerExit(bPid, 8000)

  B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStore, downloads: mkTmpDir(t), flags: bFlags })
  const after = await B.request('files:list', { spaceId })
  t.ok(after.some((e) => e.path === '/note.bin'), 'the peer’s loose file is still listed after the boot sweep')

  B.kill()
})
