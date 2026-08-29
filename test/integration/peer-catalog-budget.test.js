import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import { freshPeer } from '../helpers/store.js'
import { getStore } from '../../src/shared/core/store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { collectPeerShare } from '../../src/shared/shares/share-catalog.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'

const BUDGET = 300
const PREFIX = 'file/' + LOOSE_SHARE_ID + '/'

// collectPeerShare's drain timer is unref'd (the worker's IPC pipe keeps the loop alive); a
// bare test has no such handle, so Bare would report a deadlock before the budget fires.
async function setup (t) {
  const keep = setInterval(() => {}, 500)
  t.teardown(() => clearInterval(keep))
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), peerReadTimeoutMs: 30000, interactiveReadTimeoutMs: BUDGET })
  return ctx
}

// An owner in its own store. We replicate its catalog once so our read-only copy knows the
// length; with `readFirst` we also read the rows so their blocks land on our disk. With `depart`
// the owner then goes away: length known, no serving peer, blocks present or missing as configured.
async function catalogOwner (t, { readFirst = false, depart = true } = {}) {
  const dir = path.join(os.tmpdir(), 'mirall-test-owner-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(dir, { recursive: true })
  const store = new Corestore(dir)
  await store.ready()
  const core = store.get({ name: 'catalog' })
  await core.ready()
  const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  for (let k = 0; k < 3; k++) await bee.put(PREFIX + 'f' + k + '.bin', { size: 10 + k, mtime: 1, contentHash: 'h'.repeat(63) + k })
  const key = b4a.toString(core.key, 'hex')
  const local = getStore().get(b4a.from(key, 'hex'))
  await local.ready()
  const s1 = getStore().replicate(true)
  const s2 = store.replicate(false)
  s1.on('error', () => {})
  s2.on('error', () => {})
  s1.pipe(s2).pipe(s1)
  await local.update({ wait: true })
  if (readFirst) {
    const mine = new Hyperbee(local, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    let n = 0
    for await (const row of mine.createReadStream({ gte: PREFIX, lt: PREFIX + '\xff' })) if (row) n++
    t.is(n, 3, 'rows replicated to disk before the owner leaves')
  }
  const leave = async () => { s1.destroy(); s2.destroy(); try { await store.close() } catch {} }
  t.teardown(async () => { await leave(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  if (depart) await leave()
  return key
}

// A replication stream whose handshake never completes. Every core attached to it counts it as
// "a peer that may still have more", so update({ wait: true }) waits on it — the state of a
// socket mid-handshake, or of an owner whose replication side has stalled.
function socketMidHandshake (t) {
  const s = getStore().replicate(true)
  s.on('error', () => {})
  t.teardown(() => { try { s.destroy() } catch {} })
  return s
}

// REGRESSION (FIX-LIST-DEADLINE: collectPeerShare spent `timeoutMs` on the head sync and then
// `timeoutMs` AGAIN on the drain. An owner whose head never arrives while any socket is still
// handshaking therefore cost two budgets — the half of the files:list timeout that parallel
// reads alone cannot fix. Head sync and drain now share one deadline.)
test('REGRESSION (FIX-LIST-DEADLINE): a stalled owner costs one budget, not two', { timeout: 15000 }, async (t) => {
  await setup(t)
  const key = await catalogOwner(t)
  socketMidHandshake(t)
  await new Promise((r) => setTimeout(r, 50))

  const t0 = Date.now()
  const res = await collectPeerShare(key, LOOSE_SHARE_ID, { timeoutMs: BUDGET })
  const dt = Date.now() - t0

  t.ok(res.stalled, 'the read is reported stalled')
  t.absent(res.complete, 'and not complete')
  t.is(res.entries.length, 0, 'no rows: the blocks never arrived')
  // Two budgets today (~600 ms); one budget after (~300 ms). 1.5 budgets separates them.
  t.ok(dt < 1.5 * BUDGET, 'head sync and drain share one budget (' + dt + 'ms)')
})

// Never-blank guard for the fix above: a spent budget must not blank rows we already hold. An
// owner we listed before, now offline, keeps its rows (the renderer shows them `unavailable`).
test('rows already on disk survive a head-sync timeout', { timeout: 15000 }, async (t) => {
  await setup(t)
  const key = await catalogOwner(t, { readFirst: true })
  socketMidHandshake(t)
  await new Promise((r) => setTimeout(r, 50))

  const t0 = Date.now()
  const res = await collectPeerShare(key, LOOSE_SHARE_ID, { timeoutMs: BUDGET })
  const dt = Date.now() - t0

  t.is(res.entries.length, 3, 'the replicated rows are returned from disk')
  t.ok(res.stalled, 'still flagged stalled — the head could not be confirmed')
  t.ok(dt < 1.5 * BUDGET, 'within one budget (' + dt + 'ms)')
})

test('a live owner still reads complete', async (t) => {
  await setup(t)
  const key = await catalogOwner(t, { depart: false })
  const res = await collectPeerShare(key, LOOSE_SHARE_ID, { timeoutMs: BUDGET })
  t.is(res.entries.length, 3)
  t.ok(res.complete, 'complete on a live owner')
  t.absent(res.stalled)
})
