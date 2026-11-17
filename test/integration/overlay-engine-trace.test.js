import test from 'brittle'
import crypto from 'hypercore-crypto'
import { tmpDir, fs, path } from './overlay-engine-helpers.js'
import { overlay, link } from './overlay-link-helpers.js'
import { scaled } from '../helpers/bare-timing.js'

const settle = (ms = 300) => new Promise((r) => setTimeout(r, scaled(ms)))

function fileOnDisk(label, bytes) {
  const content = crypto.randomBytes(bytes)
  const diskPath = path.join(tmpDir(label), 'f.bin')
  fs.writeFileSync(diskPath, content)
  return { diskPath, contentHash: crypto.data(content).toString('hex'), size: content.byteLength }
}

// What the engine reports about itself while a file moves: the fetching side its needs and its
// holders, the serving side what serving cost, each in counts the caller can number.
test('a running fetch and its serve are visible as counts on both sides', async (t) => {
  const holder = await overlay(t, 'trace-holder')
  const fetcher = await overlay(t, 'trace-fetcher')
  const file = fileOnDisk('trace-src', 3 * 1024 * 1024)
  await holder.registerFile(file.diskPath, { contentHash: file.contentHash, size: file.size })
  const [, holderPeer] = link(holder, fetcher)
  await settle()

  t.alike(fetcher.traceSnapshot(), { fetches: [], serves: [] }, 'idle: nothing to report')

  const destPath = path.join(tmpDir('trace-dst'), 'f.bin')
  const during = []
  // absolute: the fetch's own idle budget, not a wait.
  await fetcher.fetchFile(file.contentHash, { destPath, size: file.size, timeout: 8000, onProgress: () => during.push(fetcher.traceSnapshot()) })

  const midway = during.find((snap) => snap.fetches[0]?.needed > 0)
  t.ok(midway, 'a snapshot was taken while chunks were still needed')
  const fetch = midway.fetches[0]
  t.is(fetch.key, destPath, 'a fetch is keyed by its destination')
  t.is(fetch.totalBytes, file.size)
  t.ok(fetch.rxBytes > 0 && fetch.rxBytes < file.size)
  t.is(fetch.holders.length, 1)
  t.is(fetch.holders[0][0], holderPeer, 'a holder is the peer object, for the caller to number')
  t.ok(fetch.inflight >= fetch.holders[0][1])
  for (const field of ['stashBytes', 'hashLag', 'readbacks', 'stashHits', 'writeMs', 'hashMs']) {
    t.ok(Number.isFinite(fetch[field]), field + ' is a number')
  }
  t.is(fetcher.traceSnapshot().fetches.length, 0, 'a finished fetch is gone')

  const serves = holder.traceSnapshot().serves
  t.is(serves.length, 1)
  t.is(serves[0].bytes, file.size, 'every byte served is counted')
  t.ok(serves[0].chunks > 1)
  t.is(serves[0].queued, 0, 'nothing is left waiting')
})

test('a holder that leaves mid-fetch hands its chunks back, and the engine says so', async (t) => {
  const events = []
  const holder = await overlay(t, 'trace-hb-holder')
  const fetcher = await overlay(t, 'trace-hb-fetcher', { onTrace: (kind, fields) => events.push({ kind, ...fields }) })
  const file = fileOnDisk('trace-hb-src', 3 * 1024 * 1024)
  await holder.registerFile(file.diskPath, { contentHash: file.contentHash, size: file.size })
  const [, holderPeer] = link(holder, fetcher)
  await settle()

  const destPath = path.join(tmpDir('trace-hb-dst'), 'f.bin')
  let dropped = false
  const fetching = fetcher.fetchFile(file.contentHash, {
    destPath,
    size: file.size,
    // absolute: the fetch's own idle budget, not a wait.
    timeout: 8000,
    onProgress: () => {
      if (dropped) return
      dropped = true
      holderPeer.channel.close()
    },
  })
  // How the fetch itself ends is not the subject: the hand-back is.
  await fetching.catch(() => {})
  const handback = events.find((event) => event.kind === 'handback')
  t.ok(handback, 'the hand-back was reported')
  t.is(handback.key, destPath)
  t.is(handback.peer, holderPeer)
  t.ok(handback.n > 0, 'with the number of chunks it still owed')
  t.is(holder.traceSnapshot().serves.length, 0, 'a closed peer\'s serve counts are forgotten')
})
