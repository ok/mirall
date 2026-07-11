import test from 'brittle'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true, identityKEK: kekHex() })

// REGRESSION (FIX-1): owner quits WHILE a loose file is still indexing (contentHash:null).
// The peer must flip that file preparing→unavailable once the owner drops from presence —
// not leave it stuck on "Preparing…" forever. Times out on unpatched code (stuck 'preparing').
test('loose file caught mid-index degrades preparing→unavailable when owner quits',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    // Big enough that the owner's hashing window is observable to the peer before it completes.
    const src = path.join(mkTmpDir(t), 'reel.bin')
    const bytes = patternedBytes(128 * 1024 * 1024, 15)
    fs.writeFileSync(src, bytes)
    A.request('files:add', { spaceId, filePath: src, fileName: 'reel.bin', fileSize: bytes.length }).catch(() => {})

    // Catch the preparing window (the null-hash entry replicates to B before the hash lands).
    await B.until('files:list', { spaceId },
      (l) => Array.isArray(l) && l.find((e) => e.path === '/reel.bin')?.status === 'preparing',
      { ms: 60000, every: 100 })

    // Owner quits mid-index — the graceful {type:'shutdown'} the Electron main sends.
    await A.request('shutdown').catch(() => {})
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 90000 })

    // The mid-index file must NOT stay preparing — it degrades to unavailable like every other
    // file from an offline owner.
    const settled = await B.until('files:list', { spaceId },
      (l) => Array.isArray(l) && l.find((e) => e.path === '/reel.bin')?.status === 'unavailable',
      { ms: 30000, every: 200 })
    t.is(settled.find((e) => e.path === '/reel.bin').status, 'unavailable',
      'mid-index file is unavailable while owner offline, not stuck preparing')
  })
