import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare } from '../helpers/owned.js'
import { initialPublishScan, initOwnedFolders, stopIndexAnnounce } from '../../src/shared/folders/owned-folders.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Hold every publish open for `ms` so the queue's SHAPE stops changing: with both slots filled and
// nothing settling, the only thing that can still speak is the re-announce timer. Mirrors the
// slowHash helper in owned-publish-queue.test.js.
function slowHash (t, ms) {
  const overlay = getOverlay()
  const orig = overlay.prepareForServe.bind(overlay)
  overlay.prepareForServe = async (diskPath, opts) => { await sleep(ms); return orig(diskPath, opts) }
  t.teardown(() => { overlay.prepareForServe = orig })
}

// Members are told about a scan by frames sent when the queue changes shape — and a queue stuck
// behind one multi-GB hash changes shape twice in several minutes. A member who opens the folder in
// between, or reconnects mid-scan, would learn nothing at all, which is exactly the case the notice
// exists for. An active share therefore re-announces itself; ephemeral status is re-announced,
// never replayed.
test('an active scan re-announces itself while its queue is unchanged', async (t) => {
  const { spaceId, share, mountPath, fake } = await setupOwnedShare(t)
  const sent = []
  initOwnedFolders(fake.ipc, { broadcastIndex: (sid, p) => sent.push({ spaceId: sid, ...p }), indexAnnounceMs: 40 })
  t.teardown(() => stopIndexAnnounce())

  slowHash(t, 900)
  for (const name of ['a.bin', 'b.bin', 'c.bin']) fs.writeFileSync(path.join(mountPath, name), name.repeat(64))

  const scan = initialPublishScan(spaceId, share.id, mountPath, [])
  // Long enough for many announce ticks, comfortably inside the 900ms every publish is held for,
  // so nothing settles in this window and no shape change can account for the frames.
  await sleep(60)
  const settled = sent.length
  await sleep(300)

  const extra = sent.slice(settled)
  t.ok(extra.length >= 2, `the scan kept speaking with nothing changing (${extra.length} re-announcements)`)
  t.ok(extra.every((f) => f.shareId === share.id && f.adding > 0), 'each names the share and its outstanding work')
  t.ok(extra.every((f) => f.spaceId === spaceId), 'and the space it belongs to')

  await scan
  t.ok(sent.some((f) => f.adding === 0), 'a drained lane is announced too, so a member can clear the notice')
  await sleep(120)
  const afterDrain = sent.length
  await sleep(160)
  t.is(sent.length, afterDrain, 'and the timer stops itself once there is nothing to say')
})
