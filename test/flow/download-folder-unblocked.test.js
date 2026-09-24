import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// REGRESSION (FIX-450: a fixed download folder is not retried while the owner stays connected).
//
// A download refused by a read-only folder is terminal, and the reconcile that re-drives it once
// the folder is fixed runs on an owner reconnect or a catalog append. With the owner connected the
// whole time there is neither, so the convergence tick has to be the trigger. The tick is shrunk
// so the wait is the folder verdict's one-minute memo, not the production cadence.

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const flags = () => ({ identityKEK: kekHex(), convergenceTickMs: 3000 })

// Null where the mode bits do not bind this process (Windows, root): the probe write is the test.
function makeReadOnly(dir) {
  fs.chmodSync(dir, 0o555)
  try {
    fs.writeFileSync(path.join(dir, '.probe'), 'x')
    fs.chmodSync(dir, 0o755)
    return false
  } catch {
    return true
  }
}

test('a download refused by a read-only folder lands once the folder is fixed, with the owner still connected', { timeout: scaled(240000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const aSrc = mkTmpDir(t)
  const bDownloads = mkTmpDir(t)
  t.teardown(() => { try { fs.chmodSync(bDownloads, 0o755) } catch {} })
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: bDownloads, flags: flags() })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).personKey

  const bytes = patternedBytes(1024 * 1024, 45)
  fs.writeFileSync(path.join(aSrc, 'doc.bin'), bytes)
  await A.request('files:add', { spaceId, filePath: path.join(aSrc, 'doc.bin'), fileName: 'doc.bin', fileSize: bytes.length })
  await B.until('files:list', { spaceId }, (f) => Array.isArray(f) && f.some((e) => e.path === '/doc.bin' && e.status === 'remote'), { ms: 120000 })

  if (!makeReadOnly(bDownloads)) { t.comment('skipped: chmod does not make a folder read-only for this process (Windows or root)'); t.pass(); A.kill(); return }

  let ownerOfflinePauses = 0
  B.on('event:transfer-paused', (m) => { if (m.path === '/doc.bin' && m.reason === 'offline') ownerOfflinePauses++ })
  const refused = B.waitFor('event:transfer-error', (m) => m.path === '/doc.bin', 60000)
  await B.request('files:download', { spaceId, path: '/doc.bin', inPlace: true, ownerKey: aKey })
  t.is((await refused).errorCode, 'TRANSFER_PERMISSION', 'precondition: the read-only folder refused the download')

  // The download attempt itself provokes connection-driven re-drives (the content-plane hello's
  // resume fan-out), and those fire within moments of it. The folder is fixed only after they have
  // come and gone and left the row errored, so what lands it afterwards can only be the tick.
  await new Promise((r) => setTimeout(r, scaled(15000)))
  const listed = (await B.request('files:list', { spaceId })).find((e) => e.path === '/doc.bin')
  t.is(listed?.status, 'error', 'precondition: the connection-driven re-drives have come and gone, and the row is still errored')
  t.is(listed?.errorCode, 'TRANSFER_PERMISSION', 'and still names the fault the user has to clear')

  const landed = B.waitFor('event:transfer-complete', (m) => m.path === '/doc.bin', 180000)
  fs.chmodSync(bDownloads, 0o755)
  const completion = await landed
  t.ok(fs.readFileSync(completion.localPath).equals(bytes), 'the tick re-drove the download and it landed byte-exact')
  t.is(ownerOfflinePauses, 0, 'the owner stayed connected throughout — no reconnect drove this')
  A.kill()
})
