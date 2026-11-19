import test from 'brittle'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { TransferMeter, rateSamples } from '../../src/shared/transfer/transfer-meter.js'
import { countDownloaded, countUploaded } from '../../src/shared/transfer/transfer-rates.js'

const frames = (fake) => fake.emitted('event:transfer-rate').map((e) => e.payload)

async function setup(t) {
  const fake = createFakeIpc()
  const meter = new TransferMeter('transfer-meter', { ipc: fake.ipc })
  t.teardown(() => meter.close())
  await meter.ready()
  return { fake, meter }
}

test('a frame is sent while bytes move and once more when they stop', async (t) => {
  const { fake, meter } = await setup(t)
  const t0 = Date.now() + 1000
  meter._sample(t0)
  t.is(frames(fake).length, 0, 'an idle meter sends nothing')
  countDownloaded(2_000_000)
  countUploaded(500_000)
  meter._sample(t0 + 1000)
  t.alike(frames(fake)[0], { down: 2_000_000, up: 500_000, mirror: false })
  meter._sample(t0 + 2000)
  t.alike(frames(fake)[1], { down: 0, up: 0, mirror: false }, 'the closing zero frame')
  meter._sample(t0 + 3000)
  t.is(frames(fake).length, 2, 'then silence')
})

test('a mirrored folder\'s bytes count as download and mark the frame', async (t) => {
  const { fake, meter } = await setup(t)
  const t0 = Date.now() + 1000
  meter._sample(t0)
  countDownloaded(1_000_000, true)
  meter._sample(t0 + 1000)
  t.alike(frames(fake)[0], { down: 1_000_000, up: 0, mirror: true })
  countUploaded(1000)
  meter._sample(t0 + 2000)
  t.ok(frames(fake)[1].mirror, 'held across the gap between two of the mirror\'s files')
  countUploaded(1000)
  meter._sample(t0 + 8000)
  t.absent(frames(fake)[2].mirror, 'and dropped once the mirror has been quiet')
})

test('a late tick is a rate over the time that passed, not a burst', async (t) => {
  const { fake, meter } = await setup(t)
  const t0 = Date.now() + 1000
  meter._sample(t0)
  countDownloaded(4_000_000)
  meter._sample(t0 + 4000)
  t.is(frames(fake)[0].down, 1_000_000)
})

test('the history is read per window, and is gone with the meter', async (t) => {
  const { meter } = await setup(t)
  const t0 = Date.now() + 1000
  countDownloaded(1000)
  meter._sample(t0)
  meter._sample(t0 + 1000)
  t.is(rateSamples('5m').length, 2)
  t.alike(rateSamples('nonsense'), [])
  await meter.close()
  t.alike(rateSamples('5m'), [], 'nothing outlives the subsystem')
})
