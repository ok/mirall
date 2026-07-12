import test from 'brittle'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled, unscaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true, identityKEK: kekHex() })

// Headline conveyance: the owner gracefully quits WHILE a loose file is still indexing. The peer
// must both (i) see the owner offline promptly (B1 departure announce) and (ii) flip that
// mid-index file preparing→unavailable (the presence-gated status), not leave it stuck.
test('quit mid-index: owner goes offline and the mid-index file degrades to unavailable',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const src = path.join(mkTmpDir(t), 'reel.bin')
    const bytes = patternedBytes(128 * 1024 * 1024, 15)
    fs.writeFileSync(src, bytes)
    A.request('files:add', { spaceId, filePath: src, fileName: 'reel.bin', fileSize: bytes.length }).catch(() => {})
    await B.until('files:list', { spaceId },
      (l) => l.find((e) => e.path === '/reel.bin')?.status === 'preparing', { ms: 60000, every: 100 })

    await A.request('shutdown').catch(() => {})
    // Bound stays under the un-scaled 15s PRESENCE_TTL_MS so a broken announce can't pass via
    // plain lease expiry under scaled CI.
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: unscaled(12000) })
    const settled = await B.until('files:list', { spaceId },
      (l) => l.find((e) => e.path === '/reel.bin')?.status === 'unavailable', { ms: 20000 })
    t.is(settled.find((e) => e.path === '/reel.bin').status, 'unavailable',
      'mid-index file resolves to unavailable, not stuck preparing')
  })
