import test from 'brittle'
import { initPublishProgress, resetPublishProgress, makePublishProgress } from '../../src/shared/transfer/backends/overlay/publish-progress.js'

function wired(t) {
  const emitted = []
  const broadcasts = []
  initPublishProgress({ emit: (name, payload) => emitted.push([name, payload]), broadcast: (spaceId, payload) => broadcasts.push([spaceId, payload]) })
  t.teardown(resetPublishProgress)
  return { emitted, broadcasts }
}

const KEY = { spaceId: 'S', shareId: 'sh', relPath: 'a.bin', decoKey: 'sh:a.bin' }

test('a bar that was never raised emits no terminal frame', (t) => {
  const { emitted, broadcasts } = wired(t)
  const progress = makePublishProgress(KEY)
  progress.onProgress(10)
  progress.done()
  t.is(emitted.length, 0)
  t.is(broadcasts.length, 0)
})

test('a raised bar ticks as publishing on both sides and terminates on both', (t) => {
  const { emitted, broadcasts } = wired(t)
  const progress = makePublishProgress(KEY)
  progress.onAdvertised(100)
  progress.onProgress(10)
  t.alike(emitted[0][0], 'event:decoration')
  t.alike(emitted[0][1], { channel: 'transfer', spaceId: 'S', key: 'sh:a.bin', phase: 'publishing', bytes: 10, total: 100, speed: emitted[0][1].speed, eta: emitted[0][1].eta })
  t.alike(broadcasts[0], ['S', { shareId: 'sh', relPath: 'a.bin', bytes: 10, total: 100, eta: broadcasts[0][1].eta }])
  progress.done()
  t.alike(emitted.at(-1), ['event:decoration', { channel: 'transfer', spaceId: 'S', key: 'sh:a.bin', done: true }])
  t.alike(broadcasts.at(-1), ['S', { shareId: 'sh', relPath: 'a.bin', done: true }])
})

test('an unwired reporter is inert rather than throwing', (t) => {
  resetPublishProgress()
  const progress = makePublishProgress(KEY)
  progress.onAdvertised(5)
  progress.onProgress(5)
  progress.done()
  t.pass('no emitter, no broadcast, no throw')
})
