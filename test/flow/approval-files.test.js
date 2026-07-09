import test from 'brittle'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir, writeTmpFile, patternedBytes } from '../helpers/fixtures.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ identityKEK: kekHex(), membershipApprovalEnabled: true })

// Owner adds files, a member joins and sees them, then that member (a CO-MEMBER, not the owner)
// approves a third peer — who must also see the owner's files. The owner's drive key now rides the
// replicated records (markSpaceDriveKey), so a transitively-approved member can open the owner's
// drive even without a direct handshake with the owner.
test('a transitively-approved member sees the owner\'s files', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })

  const space = await A.request('space:create', { name: 'Secret' })
  const S = space.spaceId
  const bKey = (await B.request('profile:get')).publicKey
  const cKey = (await C.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: S })

  const bytes = patternedBytes(64 * 1024, 9)
  const src = writeTmpFile(bytes, t)
  await A.request('files:add', { spaceId: S, filePath: src, fileName: 'movie.bin', fileSize: bytes.length })

  // B joins, owner approves B → B sees the file.
  const aSawB = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aSawB
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === S)
  await A.request('space:approve-member', { spaceId: S, publicKey: bKey })
  await bGranted
  await B.until('files:list', { spaceId: S }, (l) => Array.isArray(l) && l.some((f) => f.path === '/movie.bin'), { ms: 60000, every: 500 })

  // B (co-member) approves C.
  const bSawC = B.waitFor('event:member-join-request', (m) => m.spaceId === S && m.publicKey === cKey)
  await C.request('space:join', { inviteCode: invite })
  await bSawC
  const cGranted = C.waitFor('event:membership-granted', (m) => m.spaceId === S)
  await B.request('space:approve-member', { spaceId: S, publicKey: cKey })
  await cGranted

  // The transitively-approved member must see the owner's file.
  await C.until('files:list', { spaceId: S }, (l) => Array.isArray(l) && l.some((f) => f.path === '/movie.bin'), { ms: 90000, every: 1000 })
  t.pass('C (approved by co-member B) sees the owner\'s file')
})
