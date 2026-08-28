import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// REGRESSION (FIX-SCAN-1, flow): a file added while the owner was still indexing was tombstoned by
// the scan's stale snapshot, so a browsing peer saw it appear and then disappear — and it stayed
// gone until the 6-hourly reconcile. The listing must grow monotonically and converge to 4.
test('a file added mid-index reaches a peer and never disappears from its listing', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Media' })
  const folder = mkTmpDir(t)
  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(folder, 'big-' + i + '.bin'), patternedBytes(128 * 1024 * 1024, i))
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })

  // chokidar lives in Electron main, so the harness delivers the frame the watcher would have sent.
  const late = path.join(folder, 'late.bin')
  fs.writeFileSync(late, patternedBytes(8 * 1024 * 1024, 9))
  await A.request('event:owned-folder-fs-event', { shareId: share.id, action: 'add', relPath: 'late.bin', absPath: late })

  let peak = 0
  let monotonic = true
  let sawLate = false
  let lostLate = false
  const deadline = Date.now() + scaled(240000)
  while (Date.now() < deadline) {
    const res = await B.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id }).catch(() => ({ entries: [] }))
    const names = Array.isArray(res?.entries) ? res.entries.map((e) => e.relPath) : []
    if (names.length < peak) monotonic = false
    peak = Math.max(peak, names.length)
    if (names.includes('late.bin')) sawLate = true
    else if (sawLate) lostLate = true
    if (peak === 4 && sawLate && !lostLate && names.length === 4) break
    await new Promise((r) => setTimeout(r, scaled(500)))
  }
  t.ok(monotonic, 'the peer listing never shrank (peak ' + peak + ')')
  t.ok(sawLate, 'the mid-index addition reached the peer')
  t.absent(lostLate, 'and was never tombstoned out from under it')
  t.is(peak, 4, 'converges to the full file count')

  // The peer's listing includes 'preparing' rows (advertised, hash not yet materialized), so it
  // can reach 4 names while the last hash is still running — wait for the owner to go idle.
  const idle = await A.until('owned-folder:index-status', { spaceId, shareId: share.id },
    (s) => s && s.queued + s.running === 0, { ms: 120000 })
  t.ok(idle, 'the owner reports an idle index')
})

// REQUIREMENT (per-space queue): a large index in one space must not stall another space's work.
test('a big index in one space does not stall a second space', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const s1 = await connectInSpace(t, A, B, 'Space One')
  const s2 = await connectInSpace(t, A, B, 'Space Two')
  const aKey = (await A.request('profile:get')).publicKey

  const heavy = await A.request('share:create', { spaceId: s1, name: 'Heavy' })
  const heavyDir = mkTmpDir(t)
  for (let i = 1; i <= 4; i++) fs.writeFileSync(path.join(heavyDir, 'h' + i + '.bin'), patternedBytes(384 * 1024 * 1024, i))
  await A.request('owned-folder:mount', { spaceId: s1, shareId: heavy.id, mountPath: heavyDir })

  const light = await A.request('share:create', { spaceId: s2, name: 'Light' })
  const lightDir = mkTmpDir(t)
  fs.writeFileSync(path.join(lightDir, 'note.txt'), 'hello')
  const started = Date.now()
  await A.request('owned-folder:mount', { spaceId: s2, shareId: light.id, mountPath: lightDir })
  // The precondition, asserted so a fast machine cannot pass this trivially: the heavy index is
  // still holding slots when the light folder asks for one.
  const heavyStatus = await A.request('owned-folder:index-status', { spaceId: s1, shareId: heavy.id })
  t.ok(heavyStatus.queued + heavyStatus.running > 0, 'the heavy space is still indexing (' + JSON.stringify(heavyStatus) + ')')

  const seen = await B.until('share:list-files', { spaceId: s2, ownerKey: aKey, shareId: light.id },
    (f) => f?.entries?.some((e) => e.relPath === 'note.txt'), { ms: 120000 })
  t.ok(seen, 'the small file in space 2 publishes')
  // The bound is one file, not one folder: space 2 takes a slot as soon as it has work.
  t.ok(Date.now() - started < scaled(120000), 'and did not wait out the heavy space (took ' + (Date.now() - started) + 'ms)')
})
