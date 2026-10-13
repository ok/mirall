import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { until } from '../helpers/poll.js'

// Sparse, so it costs no disk, and long enough to hash that the files behind it stay queued for as
// long as an assertion takes on any machine.
const HOLD_SIZE = 8 * 1024 * 1024 * 1024
const HOLDERS = ['hold-0.bin', 'hold-1.bin', 'hold-2.bin']
const QUEUED = ['take-0.txt', 'take-1.txt', 'take-2.txt']

const listOf = async (peer, spaceId) => (await peer.files(spaceId).catch(() => null)) || []
const statusOf = (rows, name) => rows.find((r) => r.path === '/' + name)?.status

function add(peer, spaceId, dir, name) {
  return peer.request('files:add', { spaceId, filePath: path.join(dir, name), fileName: name, fileSize: fs.statSync(path.join(dir, name)).size })
}

// Every publish slot (two bulk slots and the express lane) held by a long hash, then the files under
// test added behind them.
async function holdSlotsThenQueue(t, A, spaceId) {
  const dir = mkTmpDir(t)
  for (const name of HOLDERS) {
    fs.closeSync(fs.openSync(path.join(dir, name), 'w'))
    fs.truncateSync(path.join(dir, name), HOLD_SIZE)
  }
  const holding = HOLDERS.map((name) => add(A, spaceId, dir, name))
  t.ok(await until(async () => {
    const rows = await listOf(A, spaceId)
    return HOLDERS.every((n) => statusOf(rows, n) === 'publishing')
  }, 60000, { interval: 50 }), 'precondition: every publish slot is held')
  for (const name of QUEUED) fs.writeFileSync(path.join(dir, name), name.repeat(1024))
  const adds = QUEUED.map((name) => add(A, spaceId, dir, name))
  t.ok(await until(async () => {
    const rows = await listOf(A, spaceId)
    return QUEUED.every((n) => statusOf(rows, n) === 'queued')
  }, 60000, { interval: 50 }), 'precondition: the files behind them are queued')
  const release = async () => {
    for (const name of HOLDERS) await A.request('files:cancel-publish', { spaceId, path: '/' + name })
    await Promise.allSettled(holding)
  }
  return { adds, release }
}

// REGRESSION (FIX-LOOSE-QUEUED-MEMBERS: a loose add waiting for a publish slot had no catalog
// entry, so a member saw only the files the owner was hashing.)
test('REGRESSION (FIX-LOOSE-QUEUED-MEMBERS): a member lists the files the owner still has queued',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t) })
    const spaceId = await connectInSpaceWithApproval(t, A, B)
    const { adds, release } = await holdSlotsThenQueue(t, A, spaceId)

    t.ok(await until(async () => {
      const rows = await listOf(B, spaceId)
      return QUEUED.every((n) => statusOf(rows, n) === 'preparing')
    }, 60000, { interval: 100 }), 'the member lists every queued file, as preparing')
    const ownerRows = await listOf(A, spaceId)
    t.ok(QUEUED.every((n) => statusOf(ownerRows, n) === 'queued'), 'while the owner still has them queued')

    await release()
    await Promise.all(adds)
    t.ok(await until(async () => {
      const rows = await listOf(B, spaceId)
      return QUEUED.every((n) => statusOf(rows, n) === 'remote')
    }, 60000, { interval: 200 }), 'and each becomes available to the member in its turn')
    A.kill()
  })

test('a queued add the owner cancels is never recorded as shared', { timeout: scaled(240000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const { spaceId } = await A.request('space:create', { name: 'Solo' })
  const { adds, release } = await holdSlotsThenQueue(t, A, spaceId)

  await A.request('files:cancel-publish', { spaceId, path: '/' + QUEUED[0] })
  await release()
  await Promise.allSettled(adds)

  const { entries } = await A.request('audit:list', { limit: 200 })
  const shared = entries.filter((e) => e.kind === 'file.shared').map((e) => e.target?.name)
  t.absent(shared.includes(QUEUED[0]), 'the cancelled queued file is not in the Activity Log as shared')
  t.ok(QUEUED.slice(1).every((n) => shared.includes(n)), 'the files that finished are')
  t.absent(HOLDERS.some((n) => shared.includes(n)), 'and the cancelled long hashes are not either')
  A.kill()
})
