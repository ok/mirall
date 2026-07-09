import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ identityKEK: kekHex(), membershipApprovalEnabled: true })

// #326 + #330: a loose (in-place) file in a v2 space rides the SCK-ENCRYPTED catalog, whose key is
// carried on the handshake in the looseCatalogKeyEnc field (not the plaintext looseCatalogKey). So a
// pending joiner (no SCK) cannot list it even though it's connected, and an approved member (holding
// the SCK) lists + downloads it — exercising the encrypted handshake routing end-to-end.
test('REGRESSION (FIX-326): v2 loose file — pending joiner cannot list; approved member converges', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

  const space = await A.request('space:create', { name: 'Secret' })
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: space.spaceId })

  const bytes = patternedBytes(64 * 1024, 7)
  const srcPath = path.join(mkTmpDir(t), 'secret.txt')
  fs.writeFileSync(srcPath, bytes)
  await A.request('files:add', { spaceId: space.spaceId, filePath: srcPath, fileName: 'secret.txt', fileSize: bytes.length })

  const aReq = A.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId && m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aReq
  t.is((await B.request('spaces:list')).find((s) => s.spaceId === space.spaceId)?.status, 'pending', 'B is pending')

  // Pending B (no SCK) cannot decrypt the encrypted loose catalog. The post-approval convergence
  // below proves the pipeline works, so this emptiness is the SCK gate, not lag.
  await new Promise((r) => setTimeout(r, scaled(4000)))
  const pre = await B.request('files:list', { spaceId: space.spaceId })
  t.absent((Array.isArray(pre) ? pre : []).some((e) => e.path === '/secret.txt'),
    'pending joiner cannot list the encrypted loose file')

  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === space.spaceId)
  await A.request('space:approve-member', { spaceId: space.spaceId, publicKey: bKey })
  await bGranted

  const listed = await B.until('files:list', { spaceId: space.spaceId },
    (f) => Array.isArray(f) && f.some((e) => e.path === '/secret.txt' && e.inPlace),
    { ms: scaled(60000) })
  t.ok(listed.find((e) => e.path === '/secret.txt')?.hash, 'approved member lists the encrypted loose file')

  const done = B.waitFor('event:transfer-complete', (m) => m.path === '/secret.txt', scaled(60000))
  await B.request('files:download', { spaceId: space.spaceId, path: '/secret.txt', inPlace: true, ownerKey: aKey })
  const completed = await done
  t.ok(fs.readFileSync(completed.localPath).equals(bytes), 'approved member downloads matching bytes')
})
