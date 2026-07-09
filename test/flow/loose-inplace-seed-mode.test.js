import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// REGRESSION (FIX-327): a peer's loose (in-place) files must converge into another peer's
// files:list in a v1 space too — not only in full-v2 spaces. Before the fix, looseCatalogKey was
// hydrated ONLY by the v2 member-view fold (member-registry openMemberView, which returns early
// unless schemaVersion === 2), so in a v1 space every peer member had looseCatalogKey === null and
// collectLooseInPlace dropped them, hiding all peer loose files. The fix carries looseCatalogKey on
// the handshake (like driveKey), so it hydrates from the handshake without the v2 fold.
//
// Both shapes below are v1 (schemaVersion !== 2 — no membershipApproval): 'seed' has no identity
// store, 'identity-kek' has one but still no approval. overlay + inPlaceFiles default ON.
const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const V1_MODES = [
  { name: 'seed', flags: () => ({}) },
  { name: 'identity-kek', flags: () => ({ identityKEK: kekHex() }) },
]

for (const mode of V1_MODES) {
  test(`REGRESSION (FIX-327): peer loose file converges in a v1 space [${mode.name}]`,
    { timeout: scaled(180000) }, async (t) => {
      const bootstrap = await localTestnet(t)
      const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: mode.flags() })
      const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: mode.flags() })
      const spaceId = await connectInSpace(t, A, B)
      const aKey = (await A.request('profile:get')).publicKey

      // Alice shares a loose file (addFile always routes to the overlay loose path now).
      const bytes = patternedBytes(64 * 1024, 5)
      const srcPath = path.join(mkTmpDir(t), 'shared.txt')
      fs.writeFileSync(srcPath, bytes)
      await A.request('files:add', { spaceId, filePath: srcPath, fileName: 'shared.txt', fileSize: bytes.length })

      // Bob must SEE it in his flat list from Alice's replicated loose catalog — the assertion
      // that timed out before the fix.
      const listed = await B.until('files:list', { spaceId },
        (f) => Array.isArray(f) && f.some((e) => e.path === '/shared.txt' && e.inPlace && e.status === 'remote'),
        { ms: scaled(60000) })
      const entry = listed.find((e) => e.path === '/shared.txt')
      t.is(entry.size, bytes.length, 'catalog carries the size')
      t.ok(entry.hash, 'catalog carries the content hash')

      // And can fetch it end-to-end — proves the looseCatalogKey actually opens the catalog + serves.
      const done = B.waitFor('event:transfer-complete', (m) => m.path === '/shared.txt', scaled(60000))
      const res = await B.request('files:download', { spaceId, path: '/shared.txt', inPlace: true, ownerKey: aKey })
      t.ok(res?.transferId, 'in-place download returned a transferId')
      const completed = await done
      t.ok(fs.readFileSync(completed.localPath).equals(bytes), 'downloaded bytes match the source')
    })
}
