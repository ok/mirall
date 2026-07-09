import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

// CRIT-9 (flow) — two different owners each share a folder with the SAME name
// ("Docs"). A member who sees both owners must treat them as two distinct shares
// (deduped by owner:id, not by name), each with its own file list. If name alone
// keyed a share, the two would collide and one would be hidden or overwritten.
//
// This is a 2-peer test on purpose: each peer is itself a member alongside the
// other owner, so each sees its own "Docs" plus the peer's "Docs" — which is all
// the dedupe-by-owner logic needs. (A genuine *third* observer would additionally
// depend on transitive membership propagation — a peer learning co-members it did
// not directly invite — which is a separate, still-open convergence gap.)
test('two owners sharing the same folder name stay distinct, each with its own files', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey

  // A and B each create a share literally named "Docs" with distinct content.
  const aShare = await A.request('share:create', { spaceId, name: 'Docs' })
  const aFolder = mkTmpDir(t)
  fs.writeFileSync(path.join(aFolder, 'from-alice.txt'), 'alice content')
  const aScan = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === aShare.id)
  await A.request('owned-folder:mount', { spaceId, shareId: aShare.id, mountPath: aFolder })
  await aScan

  const bShare = await B.request('share:create', { spaceId, name: 'Docs' })
  const bFolder = mkTmpDir(t)
  fs.writeFileSync(path.join(bFolder, 'from-bob.txt'), 'bob content')
  const bScan = B.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === bShare.id)
  await B.request('owned-folder:mount', { spaceId, shareId: bShare.id, mountPath: bFolder })
  await bScan

  // From A's vantage point: both "Docs" shares are present and distinct (one own,
  // one peer), keyed by owner — same from B's vantage point.
  for (const [viewer, who] of [[A, 'A'], [B, 'B']]) {
    const shares = await viewer.until('share:list', { spaceId },
      (l) => l.some((s) => s.id === aShare.id) && l.some((s) => s.id === bShare.id), { ms: 90000, every: 1000 })
    const docs = shares.filter((s) => s.name === 'Docs')
    t.is(docs.length, 2, `${who} sees two distinct shares both named "Docs"`)
    t.alike(docs.map((s) => s.owner).sort(), [aKey, bKey].sort(), `${who}: the two are owned by A and B`)
  }

  // Each "Docs" carries its own owner's file, not the other's — verified from the
  // opposite owner's side (cross-peer read).
  const aFilesSeenByB = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: aShare.id },
    (f) => Array.isArray(f?.entries) && f.entries.length === 1, { ms: 90000 })
  const bFilesSeenByA = await A.until('share:list-files', { spaceId, ownerKey: bKey, shareId: bShare.id },
    (f) => Array.isArray(f?.entries) && f.entries.length === 1, { ms: 90000 })
  t.alike(aFilesSeenByB.entries.map((f) => f.relPath), ['from-alice.txt'], "A's Docs holds Alice's file (seen by B)")
  t.alike(bFilesSeenByA.entries.map((f) => f.relPath), ['from-bob.txt'], "B's Docs holds Bob's file (seen by A)")
})
