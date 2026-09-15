import test from 'brittle'
import { cancelSpaceOn, reconcileActiveSlots } from '../../src/shared/transfer/backends/overlay/active-transfers.js'

const quiet = { warn() {}, debug() {} }

function fakeEngine(slots) {
  const calls = { cancel: [], dropRemoved: [], releaseForRepublish: [], supersede: [] }
  return {
    calls,
    activeSlots: () => new Map(Object.entries(slots)).entries(),
    cancel: async (id) => {
      calls.cancel.push(id)
      if (id.startsWith('bad')) throw new Error('row locked')
    },
    dropRemoved: async (spaceId, pendingKey, transferId) => { calls.dropRemoved.push([spaceId, pendingKey, transferId]) },
    releaseForRepublish: (transferId) => { calls.releaseForRepublish.push(transferId) },
    supersede: (transferId, job, inflightHash) => { calls.supersede.push([transferId, job, inflightHash]) },
  }
}

test('cancelSpaceOn cancels every slot of the space and no other', async (t) => {
  const engine = fakeEngine({ a: { spaceId: 'S' }, b: { spaceId: 'T' }, c: { spaceId: 'S' } })
  await cancelSpaceOn(engine, 'S', quiet)
  t.alike(engine.calls.cancel.sort(), ['a', 'c'])
})

test('cancelSpaceOn is per-id best-effort: one refused cancel does not abort the rest', async (t) => {
  const warned = []
  const engine = fakeEngine({ bad1: { spaceId: 'S' }, ok1: { spaceId: 'S' } })
  await cancelSpaceOn(engine, 'S', { warn: (...a) => warned.push(a), debug() {} })
  t.alike(engine.calls.cancel.sort(), ['bad1', 'ok1'], 'both were attempted')
  t.is(warned.length, 1, 'and the refusal was logged, not thrown')
})

const slot = (over = {}) => ({ spaceId: 'S', pendingKey: '/Vault/a.bin', contentHash: 'h1', sourceSeq: 3, finalPath: '/dl/a.bin', ...over })

async function reconcile(slots, states, buildJob = async () => ({ job: true })) {
  const engine = fakeEngine(slots)
  await reconcileActiveSlots({
    engine,
    spaceId: 'S',
    log: quiet,
    ownsSlot: (s) => s.mine !== false,
    entryStateFor: (s) => states[s.pendingKey],
    buildJob,
  })
  return engine.calls
}

test('a tombstoned source drops the slot', async (t) => {
  const calls = await reconcile({ t1: slot() }, { '/Vault/a.bin': { removed: true } })
  t.alike(calls.dropRemoved, [['S', '/Vault/a.bin', 't1']])
  t.is(calls.supersede.length, 0)
})

test('a re-publish whose hash is not materialized yet parks the slot', async (t) => {
  const calls = await reconcile({ t1: slot() }, { '/Vault/a.bin': { contentHash: null, seq: 4 } })
  t.alike(calls.releaseForRepublish, ['t1'])
  t.is(calls.dropRemoved.length, 0)
})

test('a re-published, different hash supersedes with the rebuilt job and the in-flight hash', async (t) => {
  const calls = await reconcile({ t1: slot() }, { '/Vault/a.bin': { contentHash: 'h2', seq: 4 } })
  t.alike(calls.supersede, [['t1', { job: true }, 'h1']])
})

test('a re-add of identical content drops rather than resumes the old partial', async (t) => {
  const calls = await reconcile({ t1: slot() }, { '/Vault/a.bin': { contentHash: 'h1', seq: 4 } })
  t.alike(calls.dropRemoved, [['S', '/Vault/a.bin', 't1']])
})

test('an unchanged entry leaves the slot alone', async (t) => {
  const calls = await reconcile({ t1: slot() }, { '/Vault/a.bin': { contentHash: 'h1', seq: 3 } })
  t.is(calls.dropRemoved.length + calls.releaseForRepublish.length + calls.supersede.length, 0)
})

test('a job that cannot be rebuilt is not superseded', async (t) => {
  const calls = await reconcile({ t1: slot() }, { '/Vault/a.bin': { contentHash: 'h2', seq: 4 } }, async () => null)
  t.is(calls.supersede.length, 0)
})

test('slots of another space or another owner are skipped without a read', async (t) => {
  let reads = 0
  const engine = fakeEngine({ other: slot({ spaceId: 'T' }), foreign: slot({ mine: false }) })
  await reconcileActiveSlots({
    engine, spaceId: 'S', log: quiet,
    ownsSlot: (s) => s.mine !== false,
    entryStateFor: () => { reads++; return { removed: true } },
    buildJob: async () => null,
  })
  t.is(reads, 0)
  t.is(engine.calls.dropRemoved.length, 0)
})
