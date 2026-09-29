import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
// identity.enc is written beside the store (dirname(storage)), so each identity
// peer needs its own store parent — mirror production's <userData>/app-storage.
const identityStore = (t) => path.join(mkTmpDir(t), 'app-storage')

test('explicit-keypair peers replicate a shared file', { timeout: scaled(150000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: identityStore(t), downloads: mkTmpDir(t), flags: { identityKEK: kekHex() } })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: identityStore(t), downloads: mkTmpDir(t), flags: { identityKEK: kekHex() } })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).personKey

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

test('migration through the real worker preserves the network identity', { timeout: scaled(150000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const root = mkTmpDir(t)
  const storage = path.join(root, 'app-storage')
  const downloads = mkTmpDir(t)

  // A pre-envelope store, written the way a keyless build left it: the profile bee on a core derived
  // from the store's own seed by name. That seed-derived core is what makes the first KEK boot a
  // migrating install (resolveMasterSecret's hasExistingCores branch) rather than a fresh one.
  const legacy = new Corestore(storage)
  const profile = new Hyperbee(legacy.get({ name: 'profile' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await profile.put('displayName', 'Alice')
  const keyBefore = profile.core.key.toString('hex')
  await legacy.close()
  t.absent(fs.existsSync(path.join(root, 'identity.enc')), 'no envelope on the legacy install')

  // Launch the SAME storage WITH a KEK → migration carries the seed forward as M.
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage, downloads, flags: { identityKEK: kekHex() } })
  t.is((await A.request('profile:get')).personKey, keyBefore, 'network identity preserved across migration')
  t.ok(fs.existsSync(path.join(root, 'identity.enc')), 'envelope created by migration')
})
