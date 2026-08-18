import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir, writeTmpFile, patternedBytes } from '../helpers/fixtures.js'
import { KINDS } from '../../src/shared/audit/audit-kinds.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const flags = () => ({ identityKEK: kekHex(), membershipApprovalEnabled: true, handshakeIdentityBindingEnabled: true })

// What ONE realistic two-peer session must produce. This is the completeness half of the
// guarantee: if a call site stops firing, the kind drops out and this fails.
const EXPECTED_KINDS = {
  A: [
    'space.created',
    'space.updated',
    'invite.minted',
    'membership.requested',
    'membership.approved',
    'file.shared',
    'file.unshared',
    'share.created',
    'share.mounted',
    'share.relocated',
    'serve.completed',
    'peer.file_shared',
    'peer.file_unshared',
    'peer.share_created',
    'peer.share_deleted',
    'mirror.peer_mirrored',
    'mirror.peer_unmirrored',
    'member.left',
  ],
  B: [
    'space.joined',
    'membership.granted',
    'transfer.completed',
    'mirror.created',
    'mirror.removed',
    'share.created',
    'share.deleted',
    'space.left',
    // B's own loose file, published then removed.
    'file.shared',
    'file.unshared',
    // Observation runs BOTH ways: B sees A create a folder share and retire a loose file.
    'peer.share_created',
    'peer.file_unshared',
  ],
}

// Kinds a two-peer happy path cannot reach, each with the reason. Listed explicitly so the
// vocabulary can never quietly grow an untested member: the completeness test below asserts
// EXPECTED ∪ UNTRIGGERABLE covers the whole table exactly.
const UNTRIGGERABLE = {
  'membership.denied': 'needs a join that is refused — covered in audit-attribution.test.js',
  // The APPROVER deliberately does not record an arrival: membership.approved already tells that
  // story, and a second row seconds later is noise. It takes a third peer who did not approve —
  // the co-member case in audit-attribution.test.js.
  'member.joined': 'only a co-member who did not approve records an arrival',
  'membership.approval_revoked': 'needs a leave learned through replication while offline',
  'transfer.failed': 'needs a transport failure mid-fetch',
  'share.deleted': 'A deletes via owned-folder:delete; B exercises the plain share:delete path',
  'security.serve_denied': 'needs an unauthorized requester — unit-tested at the gate',
  'security.integrity_failure': 'needs bytes that fail their hash',
  'security.creator_divergence': 'needs a forked member-set root',
  'audit.suppressed': 'needs a burst past the rate guard — integration-tested',
}

async function rows (peer) {
  const out = []
  let cursor = null
  do {
    const page = await peer.request('audit:list', { cursor, limit: 100 })
    out.push(...page.entries)
    cursor = page.nextCursor
  } while (cursor !== null)
  return out
}

const kindsOf = (entries) => new Set(entries.map((e) => e.kind))

test('the expected-kind manifest accounts for the whole vocabulary, exactly', (t) => {
  const claimed = new Set([...EXPECTED_KINDS.A, ...EXPECTED_KINDS.B, ...Object.keys(UNTRIGGERABLE)])
  for (const kind of Object.keys(KINDS)) {
    t.ok(claimed.has(kind), kind + ' is either driven by the session below or explicitly accounted for')
  }
  for (const kind of claimed) {
    t.ok(Object.hasOwn(KINDS, kind), kind + ' is a real kind — a stale manifest entry hides a gap')
  }
})

test('one realistic session produces every expected kind, and nothing else', { timeout: 300000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey

  // --- space lifecycle + membership -------------------------------------------------------
  const space = await A.request('space:create', { name: 'Coverage' })
  const spaceId = space.spaceId
  await A.request('space:update', { spaceId, name: 'Coverage Renamed', icon: 'folder' })
  // An expiry makes space:invite mint a replicated per-link record, which is what is audited.
  const invite = await A.request('space:invite', { spaceId, expiresInMs: 3600000 })

  const gotRequest = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey, 120000)
  const granted = B.waitFor('event:membership-granted', (m) => m.spaceId === spaceId, 120000)
  await B.request('space:join', { inviteCode: invite })
  await gotRequest
  await A.request('space:approve-member', { spaceId, publicKey: bKey })
  await granted
  await A.until('spaces:list', {}, (l) => l.find((s) => s.spaceId === spaceId)?.members?.some((m) => m.publicKey === bKey))

  // --- loose files: A publishes, B downloads (serve on A, transfer on B) -------------------
  const bytes = patternedBytes(128 * 1024, 7)
  await A.request('files:add', { spaceId, filePath: writeTmpFile(bytes, t), fileName: 'shared.bin', fileSize: bytes.length })
  await B.until('files:list', { spaceId }, (l) => l.some((f) => f.path === '/shared.bin'), { ms: 60000, every: 500 })
  const dl = B.waitFor('event:transfer-complete', () => true, 90000)
  await B.request('files:download', { spaceId, ownerKey: aKey, path: '/shared.bin' })
  await dl
  await A.request('files:remove', { spaceId, path: '/shared.bin' })

  // --- B publishes a loose file, then removes it (peer.file_* on A) ------------------------
  await A.request('files:list', { spaceId })          // registers the catalog watch + baseline
  await new Promise((r) => setTimeout(r, 1500))
  const bBytes = patternedBytes(4096, 2)
  await B.request('files:add', { spaceId, filePath: writeTmpFile(bBytes, t), fileName: 'bobs.txt', fileSize: bBytes.length })
  await A.until('audit:list', { limit: 200 }, (p) => kindsOf(p.entries).has('peer.file_shared'))
  await B.request('files:remove', { spaceId, path: '/bobs.txt' })
  await A.until('audit:list', { limit: 200 }, (p) => kindsOf(p.entries).has('peer.file_unshared'))

  // --- A's folder share: create, mount, relocate; B mirrors then unmirrors -----------------
  const aShare = await A.request('share:create', { spaceId, name: 'AliceFolder' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'doc.txt'), 'd'.repeat(2048))
  const scanned = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === aShare.id, 60000)
  await A.request('owned-folder:mount', { spaceId, shareId: aShare.id, mountPath: folder })
  await scanned
  const moved = mkTmpDir(t)
  fs.writeFileSync(path.join(moved, 'doc.txt'), 'd'.repeat(2048))
  await A.request('owned-folder:relocate', { spaceId, shareId: aShare.id, mountPath: moved })

  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === aShare.id), { ms: 60000, every: 500 })
  await B.request('foreign-folder:mount', { spaceId, shareId: aShare.id, ownerKey: aKey, mountPath: mkTmpDir(t) })
  await A.until('audit:list', { limit: 200 }, (p) => kindsOf(p.entries).has('mirror.peer_mirrored'))
  await B.request('foreign-folder:unmount', { spaceId, shareId: aShare.id })
  await A.until('audit:list', { limit: 200 }, (p) => kindsOf(p.entries).has('mirror.peer_unmirrored'))

  // --- B's folder share: created then deleted (peer.share_* on A) --------------------------
  const bShare = await B.request('share:create', { spaceId, name: 'BobFolder' })
  await A.until('audit:list', { limit: 200 }, (p) => kindsOf(p.entries).has('peer.share_created'))
  await B.request('share:delete', { spaceId, shareId: bShare.id })
  await A.until('audit:list', { limit: 200 }, (p) => kindsOf(p.entries).has('peer.share_deleted'))

  // --- B leaves (member.left on A, space.left on B) ----------------------------------------
  await B.request('space:leave', { spaceId })
  await A.until('audit:list', { limit: 200 }, (p) => kindsOf(p.entries).has('member.left'))

  const aKinds = kindsOf(await rows(A))
  const bKinds = kindsOf(await rows(B))

  for (const kind of EXPECTED_KINDS.A) t.ok(aKinds.has(kind), 'A recorded ' + kind)
  for (const kind of EXPECTED_KINDS.B) t.ok(bKinds.has(kind), 'B recorded ' + kind)

  // The exclusivity half: an ordinary session must produce NOTHING beyond what we intend. This is
  // the guard that caught rate-limited serve requests being logged as security denials.
  const allowedA = new Set(EXPECTED_KINDS.A)
  const allowedB = new Set(EXPECTED_KINDS.B)
  for (const kind of aKinds) t.ok(allowedA.has(kind), 'A recorded ONLY expected kinds — unexpected: ' + kind)
  for (const kind of bKinds) t.ok(allowedB.has(kind), 'B recorded ONLY expected kinds — unexpected: ' + kind)
})

test('every recorded row is well formed and renderable without a join', { timeout: 300000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const space = await A.request('space:create', { name: 'Shapes' })
  const share = await A.request('share:create', { spaceId: space.spaceId, name: 'Docs' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'x.txt'), 'x')
  const scanned = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id, 60000)
  await A.request('owned-folder:mount', { spaceId: space.spaceId, shareId: share.id, mountPath: folder })
  await scanned

  for (const row of await rows(A)) {
    t.is(row.v, 1, row.kind + ' carries the schema version the backend ingests on')
    t.ok(Number.isInteger(row.seq) && row.seq >= 0, row.kind + ' has a usable cursor seq')
    t.ok(Number.isFinite(row.ts), row.kind + ' is timestamped')
    t.ok(Object.hasOwn(KINDS, row.kind), row.kind + ' is a declared kind')
    t.is(row.category, KINDS[row.kind].category, row.kind + ' stamps its category at write time')
    t.is(row.tier, KINDS[row.kind].tier, row.kind + ' stamps its tier at write time')
    t.ok(['ok', 'denied', 'error'].includes(row.outcome), row.kind + ' has a known outcome')
    t.ok(row.device, row.kind + ' names the device, for the future multi-device grouping')
    // The zero-joins rule: anything the row references must be named IN the row, because the
    // space record is deleted on leave and a peer may be unreachable.
    if (row.space) t.ok(row.space.name, row.kind + ' snapshots the space name')
    if (row.actor?.type === 'self') t.ok(row.actor.name, row.kind + ' snapshots our own display name')
    t.is(typeof row.search, 'string', row.kind + ' carries a search blob')
  }
})
