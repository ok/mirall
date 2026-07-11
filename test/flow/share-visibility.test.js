import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import crypto from 'crypto'
import { launchPeer, connectInSpace, connectInSpaceWithApproval, waitForCatalogEntry } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const v2flags = () => ({ overlayEnabled: true, inPlaceFilesEnabled: true, membershipApprovalEnabled: true, identityKEK: kekHex() })

// REGRESSION: peer-share visibility depends on an IPC EVENT, not just data replication.
// The renderer's share list (useShares) refreshes only on event:shares-updated. Share
// records live in the owner's profile bee, so when a peer adds a share, the OTHER peer's
// profile-bee append listener must emit event:shares-updated — otherwise the share
// replicates but the UI is stuck on "Nothing shared yet". The membership refactor deleted
// the reconcilePeerAcrossSpaces that carried this emission; the flow suite poll-checks data
// so it never caught it. This asserts the EVENT fires (the thing the frontend tests need).
test('REGRESSION: a peer\'s new share refreshes the other peer (event:shares-updated + list)', async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)

  const bNotified = B.waitFor('event:shares-updated', (m) => m.spaceId === spaceId, 60000)
  // The FLAT file list hides a peer's folder-share contents via prefixes read from that peer's
  // profile bee; the renderer's useFiles refreshes only on event:files-updated, so the profile-bee
  // append must emit files-updated too — else the share's files leak into B's loose-file list until
  // an unrelated files-updated fires.
  const bFilesNotified = B.waitFor('event:files-updated', (m) => m.spaceId === spaceId, 60000)
  await A.request('share:create', { spaceId, name: 'Photos' })
  await bNotified
  t.pass('B received event:shares-updated when A added a share')
  await bFilesNotified
  t.pass('B received event:files-updated too (its flat list re-derives the folder-share hide-filter)')

  await B.until('share:list', { spaceId },
    (shares) => Array.isArray(shares) && shares.some((s) => s.name === 'Photos'), { ms: 60000 })
  t.ok((await B.request('share:list', { spaceId })).some((s) => s.name === 'Photos'), 'B lists A’s "Photos" share')
})

// REGRESSION (companion): when a sharing member leaves, the other peer's share list must
// refresh so the gone owner's shares drop out. The fold's member-set change now drives the
// shares-updated emission (the old reconcile prune used to).
test('REGRESSION: a leaving member\'s shares drop from the other peer\'s list', { timeout: 120000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)

  await A.request('share:create', { spaceId, name: 'Photos' })
  await B.until('share:list', { spaceId }, (s) => Array.isArray(s) && s.some((x) => x.name === 'Photos'), { ms: 60000 })

  await A.request('space:leave', { spaceId })
  await B.until('share:list', { spaceId }, (s) => Array.isArray(s) && !s.some((x) => x.name === 'Photos'), { ms: 90000 })
  t.absent((await B.request('share:list', { spaceId })).some((x) => x.name === 'Photos'), 'Alice’s share dropped after she left')
})

// REGRESSION (HOL): a peer mid-download must still see a folder the owner shares — the
// share record replicates over the SAME Noise stream the bulk download saturates, so
// without seeder backpressure it was starved until the download paused/finished.
test('REGRESSION (HOL): a new share reaches a peer that is mid-download — no pause needed',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: v2flags() })
    const spaceId = await connectInSpaceWithApproval(t, A, B)

    const bytes = patternedBytes(96 * 1024 * 1024, 7)
    const src = path.join(mkTmpDir(t), 'big.bin')
    fs.writeFileSync(src, bytes)
    await A.request('files:add', { spaceId, filePath: src, fileName: 'big.bin', fileSize: bytes.length })

    const entry = await waitForCatalogEntry(B, spaceId, '/big.bin')
    const inFlight = B.waitFor('event:decoration', (m) => m.channel === 'transfer' && m.spaceId === spaceId && m.key === '/big.bin' && (m.bytes || 0) > 0, 60000)
    const dl = B.request('files:download', { spaceId, path: entry.path, inPlace: true, ownerKey: entry.owner.publicKey })
    dl.catch(() => {})
    const firstProgress = await inFlight
    t.ok(firstProgress.bytes < bytes.length, 'download is genuinely partial (mid-flight) when the share is created')

    // Note: on fast loopback the transfer can finish before shares-updated arrives, so this
    // is an end-to-end guard, not the deterministic proof — that lives in
    // test/integration/overlay-vendor-backpressure.test.js (seeder backpressure red-first).
    const sawShare = B.waitFor('event:shares-updated', (m) => m.spaceId === spaceId, 15000)
    await A.request('share:create', { spaceId, name: 'Vault' })
    await sawShare
    t.pass('B received event:shares-updated while the download was active — no pause required')
  })
