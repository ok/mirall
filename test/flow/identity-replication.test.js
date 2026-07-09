import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
// identity.enc is written beside the store (dirname(storage)), so each identity
// peer needs its own store parent — mirror production's <userData>/app-storage.
const identityStore = (t) => path.join(mkTmpDir(t), 'app-storage')

test('explicit-keypair peers replicate a shared file', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: identityStore(t), downloads: mkTmpDir(t), flags: { identityKEK: kekHex() } })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: identityStore(t), downloads: mkTmpDir(t), flags: { identityKEK: kekHex() } })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Photos' })
  const folder = mkTmpDir(t)
  const bytes = patternedBytes(12 * 1024, 7)
  fs.writeFileSync(path.join(folder, 'pic.bin'), bytes)
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'pic.bin'))
  const done = B.waitFor('event:transfer-complete', (m) => m.path === '/Photos/pic.bin', 60000)
  await B.request('share:read-file', { spaceId, ownerKey: aKey, shareId: share.id, relPath: 'pic.bin' })
  const completed = await done

  t.ok(fs.readFileSync(completed.localPath).equals(bytes), 'explicit-keypair drive replicated byte-exact')
})

test('migration through the real worker preserves identity and spaces', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const root = mkTmpDir(t)
  const storage = path.join(root, 'app-storage')
  const downloads = mkTmpDir(t)

  // Boot legacy (no KEK) → seed-derived identity; create a space.
  let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage, downloads })
  const keyBefore = (await A.request('profile:get')).publicKey
  const space = await A.request('space:create', { name: 'Vault' })
  t.absent(fs.existsSync(path.join(root, 'identity.enc')), 'no envelope on the legacy install')

  const pid = A.sidecar?._process?.pid
  A.kill()
  if (pid) await waitForWorkerExit(pid, 5000)

  // Relaunch the SAME storage WITH a KEK → migration carries the seed forward as M.
  A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage, downloads, flags: { identityKEK: kekHex() } })
  t.is((await A.request('profile:get')).publicKey, keyBefore, 'network identity preserved across migration')
  t.ok(fs.existsSync(path.join(root, 'identity.enc')), 'envelope created by migration')
  const spaces = await A.request('spaces:list')
  t.ok(spaces.some((s) => s.spaceId === space.spaceId), 'space survived migration')
})
