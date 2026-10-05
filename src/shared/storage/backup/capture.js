// A backup run's view of the store: a snapshot of every core, then each core's changed range since
// the previous snapshot as encoded parts. Each core is captured at one consistent point, read from its
// snapshot rather than the live core, so concurrent appends land in the next run. Cores are not
// captured at one common instant: nothing in the store points at a length of another core, so each
// restores to a valid prefix of its own.
import b4a from 'b4a'
import { proofRecords, rootTreeHash } from './core-proofs.js'
import { encodeParts, DEFAULT_PART_BYTES } from './segment-codec.js'
import { deltaPlan } from './manifest.js'

async function closeAll(sessions) {
  await Promise.all(sessions.map((session) => session.close().catch(() => {})))
}

export async function openCut(store, cores) {
  const sessions = cores.map((core) => store.get({ key: b4a.from(core.key, 'hex'), active: false }))
  const snaps = []
  try {
    await Promise.all(sessions.map((session) => session.ready()))
    for (const session of sessions) snaps.push(session.snapshot())
    await Promise.all(snaps.map((snap) => snap.ready()))
  } catch (err) {
    await closeAll([...snaps, ...sessions])
    throw err
  }
  return { snaps, close: () => closeAll([...snaps, ...sessions]) }
}

// The core as its snapshot saw it, the range to back up against `prev` (its entry in the previous
// snapshot), and that range's parts. Parts are produced as they are read, so a large core never sits
// in memory whole.
export async function captureCore(snap, core, prev, { maxPartBytes = DEFAULT_PART_BYTES } = {}) {
  const length = snap.length
  const now = {
    ...core,
    fork: snap.fork,
    length,
    contiguous: snap.contiguousLength,
    treeHash: length > 0 ? await rootTreeHash(snap, length) : null,
  }
  const continues = !prev || prev.fork !== now.fork || prev.length === 0 || length < prev.length ||
    (await rootTreeHash(snap, prev.length)) === prev.treeHash
  const plan = deltaPlan(prev, now, { extends: continues })
  const parts = plan.kind === 'full' || plan.kind === 'delta'
    ? encodeParts({ dk: core.dk, fork: now.fork, from: plan.from, to: plan.to }, proofRecords(snap, plan.from, plan.to), maxPartBytes)
    : null
  return { now, plan, parts }
}
