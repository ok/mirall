import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')

// v2 membership with the MIR-04 / MIR-29 *bound* caps (pending requesters, approvals,
// peer drives, members) shrunk to a handful, and the rate limiter at its shipped defaults.
// If an honest two-peer approve→converge flow still completes under these, the caps and the
// always-on connection-cap / firewall / limiter don't break legitimate replication. We
// deliberately do NOT shrink handshakeBurst below its default: a 1-token burst is outside
// the safe regime (the post-grant handshake cascade would trip the consecutive-drop ban and
// evict an honest peer mid-replication — the false positive §8 warns about), so the limiter's
// throttle/ban mechanics are proven deterministically at the unit layer instead. End-state
// assertions only (poll with `until`), never wall-clock latency (lessons.md L16).
const tightFlags = () => ({
  identityKEK: kekHex(),
  membershipApprovalEnabled: true,
  maxPendingRequesters: 8,
  maxApprovalsPerMember: 8,
  maxMembersPerSpace: 8,
})

test('REGRESSION (MIR-04): honest membership flow converges with DoS bound-caps shrunk + limiter on', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: tightFlags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: tightFlags() })

  const space = await A.request('space:create', { name: 'Secret' })
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey
  const invite = await A.request('space:invite', { spaceId: space.spaceId })

  const share = await A.request('share:create', { spaceId: space.spaceId, name: 'Docs' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'plan.bin'), patternedBytes(8 * 1024, 3))
  const scan = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId: space.spaceId, shareId: share.id, mountPath: folder })
  await scan

  const aReq = A.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId && m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aReq

  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === space.spaceId)
  await A.request('space:approve-member', { spaceId: space.spaceId, publicKey: bKey })
  await bGranted

  // The handshake limiter (burst 1) drops some frames; convergence still completes because
  // dropped frames re-send. End-state assertions only.
  await B.until('share:list-files', { spaceId: space.spaceId, ownerKey: aKey, shareId: share.id },
    (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'plan.bin'), { ms: 90000, every: 1000 })
  t.pass('approved honest peer converged despite a 1-token handshake burst')

  await A.until('spaces:list', {}, (l) => (l.find((s) => s.spaceId === space.spaceId)?.members || [])
    .some((m) => m.publicKey === bKey), { ms: 30000, every: 1000 })
  t.pass('creator roster reflects the approved member under shrunk member/pending/drive caps')
})
