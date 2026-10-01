import test from 'brittle'
import fs from 'bare-fs'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import { freshPeer } from '../helpers/store.js'
import { tmpDir } from '../helpers/bare-tmp.js'
import { getStore, createLocalBee, deriveSpaceContentKey } from '../../src/shared/core/store.js'
import { deriveContentKey } from '../../src/shared/core/identity-keys.js'
import { setProfile, getProfileBee } from '../../src/shared/spaces/profile.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { advertise } from '../../src/shared/shares/own-catalog.js'
import { listCores, CORE_ROLE } from '../../src/shared/storage/backup/inventory.js'
import { openCut, captureCore } from '../../src/shared/storage/backup/capture.js'
import { decodePart } from '../../src/shared/storage/backup/segment-codec.js'
import { applyRecord } from '../../src/shared/storage/backup/core-proofs.js'
import { nextCoreEntry } from '../../src/shared/storage/backup/manifest.js'

const json = { keyEncoding: 'utf-8', valueEncoding: 'json' }

// One capture run, the way the backup service will drive it: every core, one cut, each core's range
// against its previous entry. Parts are kept in memory; the entry gets placeholder part ids.
async function capture(prevByDk = new Map()) {
  const store = getStore()
  const cores = await listCores(store)
  const cut = await openCut(store, cores)
  const out = []
  try {
    for (let i = 0; i < cores.length; i++) {
      const { now, plan, parts } = await captureCore(cut.snaps[i], cores[i], prevByDk.get(cores[i].dk) ?? null, { maxPartBytes: 16 * 1024 })
      const buffers = []
      if (parts) for await (const part of parts) buffers.push(part)
      const prev = prevByDk.get(cores[i].dk) ?? null
      const entry = plan.kind === 'skip' ? null : nextCoreEntry(prev, now, plan, buffers.map((_, n) => `${cores[i].dk.slice(0, 8)}-${now.length}-${n}`))
      out.push({ core: cores[i], now, plan, buffers, entry })
    }
  } finally {
    await cut.close()
  }
  return out
}

const entries = (run) => new Map(run.filter((r) => r.entry).map((r) => [r.core.dk, r.entry]))

async function applyRun(store, run) {
  for (const { core, buffers } of run) {
    if (!buffers.length) continue
    const target = store.get({ key: b4a.from(core.key, 'hex') })
    await target.ready()
    for (const buffer of buffers) for (const record of decodePart(buffer).records) await applyRecord(target, record)
    await target.close()
  }
}

// What a restore applies per core: its last full capture and every delta after it, across runs.
async function applyChains(store, runs) {
  const chains = new Map()
  for (const run of runs) {
    for (const r of run) {
      if (r.plan.kind === 'full') chains.set(r.core.dk, { core: r.core, buffers: [...r.buffers] })
      else if (r.plan.kind === 'delta') chains.get(r.core.dk).buffers.push(...r.buffers)
    }
  }
  await applyRun(store, [...chains.values()])
}

async function restoredStore(t) {
  const dir = tmpDir('backup-capture-restore')
  const store = new Corestore(dir)
  t.teardown(async () => { await store.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }, { order: 0 })
  await store.ready()
  return store
}

async function matches(t, store, run) {
  for (const { core, now } of run) {
    if (now.length === 0) continue
    const restored = store.get({ key: b4a.from(core.key, 'hex') })
    await restored.ready()
    t.is(restored.length, now.length, `${core.role} ${core.dk.slice(0, 8)}: length`)
    t.is(b4a.toString(await restored.treeHash(now.length), 'hex'), now.treeHash, `${core.role} ${core.dk.slice(0, 8)}: tree hash`)
    await restored.close()
  }
}

async function populate() {
  const { spaceId } = await createSpace('Backed Space')
  await advertise(spaceId, 'share-1', 'secret-plans.txt', { size: 10, mtime: 1, contentHash: null })
  return spaceId
}

test('a full capture rebuilds every core in a fresh store, encrypted ones as ciphertext', async (t) => {
  const { masterSecret } = await freshPeer(t, { displayName: 'Backed Up' })
  const spaceId = await populate()
  const run = await capture()

  const roles = run.map((r) => r.core.role)
  t.ok(roles.includes(CORE_ROLE.PROFILE))
  t.ok(roles.includes(CORE_ROLE.LOCAL_BEE))
  t.ok(roles.includes(CORE_ROLE.INTENTS))
  const catalog = run.find((r) => r.core.role === CORE_ROLE.OWN_CATALOG)
  t.is(catalog?.core.spaceId, spaceId, 'the own catalog is named with its space')
  t.ok(catalog.core.name.endsWith('-e1'))
  t.absent(roles.includes(CORE_ROLE.SKIP))

  const ciphertext = b4a.toString(b4a.concat(run.filter((r) => r.core.role !== CORE_ROLE.PROFILE).flatMap((r) => r.buffers)))
  t.absent(ciphertext.includes('Backed Space'), 'the space name is not in the backup')
  t.absent(ciphertext.includes('secret-plans'), 'nor is a shared file name')

  const store = await restoredStore(t)
  await applyRun(store, run)
  await matches(t, store, run)

  const profile = new Hyperbee(store.get({ key: getProfileBee().core.key }), json)
  t.is((await profile.get('displayName')).value, 'Backed Up')
  const spacesCore = run.find((r) => r.core.role === CORE_ROLE.LOCAL_BEE && r.core.name === 'spaces-meta')
  const spaces = new Hyperbee(store.get({ key: b4a.from(spacesCore.core.key, 'hex'), encryptionKey: deriveContentKey(masterSecret, 'metadata-bees') }), json)
  t.is((await spaces.get('space/' + spaceId)).value.name, 'Backed Space', 'the encrypted local bee reads back with its key')
  const restoredCatalog = new Hyperbee(store.get({ key: b4a.from(catalog.core.key, 'hex'), encryptionKey: deriveSpaceContentKey(spaceId) }), json)
  let files = 0
  for await (const node of restoredCatalog.createReadStream()) if (node.key.includes('secret-plans')) files++
  t.is(files, 1, 'and so does the catalog under its space key')
})

test('a second capture carries only what changed, and the deltas rebuild it again', async (t) => {
  await freshPeer(t, { displayName: 'Before' })
  const spaceId = await populate()
  const first = await capture()
  const store = await restoredStore(t)
  await applyRun(store, first)

  await setProfile({ displayName: 'After' })
  await advertise(spaceId, 'share-1', 'more.txt', { size: 3, mtime: 2, contentHash: null })
  const second = await capture(entries(first))

  const profile = second.find((r) => r.core.role === CORE_ROLE.PROFILE)
  t.is(profile.plan.kind, 'delta')
  t.is(profile.entry.segments.length, 2, 'the chain grew by one range')
  t.ok(second.some((r) => r.plan.kind === 'none' && r.buffers.length === 0), 'an unchanged core writes nothing')
  t.absent(second.some((r) => r.plan.kind === 'full'), 'nothing started over')

  await applyRun(store, second)
  await matches(t, store, second)
  t.is((await new Hyperbee(store.get({ key: getProfileBee().core.key }), json).get('displayName')).value, 'After')
})

test('a truncated or forked core is backed up whole again', async (t) => {
  await freshPeer(t)
  const bee = createLocalBee('reclaim-meta')
  await bee.ready()
  for (let i = 0; i < 5; i++) await bee.put('k' + i, i)
  const first = await capture()
  await bee.core.truncate(2)
  await bee.put('again', 1)
  const second = await capture(entries(first))
  const reclaim = second.find((r) => r.core.name === 'reclaim-meta')
  t.is(reclaim.plan.kind, 'full')
  t.is(reclaim.entry.segments.length, 1)
  t.is(reclaim.now.fork, 1)

  const store = await restoredStore(t)
  await applyChains(store, [first, second])
  await matches(t, store, second)
  const restored = store.get({ key: b4a.from(reclaim.core.key, 'hex') })
  await restored.ready()
  t.is(restored.fork, 1, 'a fresh core follows the captured fork')
  await restored.close()
  await bee.close()
})

test('a core recreated under the same key is backed up whole, not as a delta of the old one', async (t) => {
  await freshPeer(t)
  const first = await capture()
  const prev = entries(first)
  const profile = first.find((r) => r.core.role === CORE_ROLE.PROFILE)
  prev.set(profile.core.dk, { ...prev.get(profile.core.dk), treeHash: 'f'.repeat(64) })
  const second = await capture(prev)
  t.is(second.find((r) => r.core.role === CORE_ROLE.PROFILE).plan.kind, 'full')
})

test('the overlay index is never backed up', async (t) => {
  await freshPeer(t)
  const { getOverlayLocalDiscoveryKeys } = await import('../../src/shared/transfer/overlay/overlay-instance.js')
  const overlay = await getOverlayLocalDiscoveryKeys()
  t.ok(overlay.length > 0, 'the overlay has local cores')
  const listed = new Set((await listCores(getStore())).map((c) => c.dk))
  t.absent(overlay.some((dk) => listed.has(dk)))
})

test('a peer core is backed up as far as it is held, and again in full once it fills in', async (t) => {
  await freshPeer(t)
  const dir = tmpDir('backup-capture-peer')
  const other = new Corestore(dir)
  t.teardown(async () => { await other.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }, { order: 0 })
  const source = other.get({ name: 'peer-catalog' })
  await source.ready()
  for (let i = 0; i < 20; i++) await source.append(b4a.from('entry-' + i))

  const local = getStore().get({ key: source.key })
  await local.ready()
  const a = getStore().replicate(true)
  const b = other.replicate(false)
  a.pipe(b).pipe(a)
  t.teardown(() => { a.destroy(); b.destroy() }, { order: 0 })
  await local.update({ wait: true })
  await local.download({ start: 10, end: 20 }).done()

  const first = await capture()
  const peer = first.find((r) => r.core.key === b4a.toString(source.key, 'hex'))
  t.is(peer.core.role, CORE_ROLE.PEER)
  t.is(peer.now.length, 20)
  t.is(peer.now.contiguous, 0)
  const store = await restoredStore(t)
  await applyRun(store, [peer])
  const restored = store.get({ key: source.key })
  await restored.ready()
  t.is(restored.length, 20)
  t.ok(await restored.has(15))
  t.absent(await restored.has(3), 'a block this device never held is not in the backup')
  await restored.close()

  await local.download({ start: 0, end: 10 }).done()
  const second = await capture(entries(first))
  t.is(second.find((r) => r.core.key === peer.core.key).plan.kind, 'full', 'the filled-in blocks are captured')
  await local.close()
})

test('a cut taken while appends run captures each core at one consistent point', async (t) => {
  await freshPeer(t)
  const bee = createLocalBee('reclaim-meta')
  await bee.ready()
  let writing = true
  const writer = (async () => { let n = 0; while (writing) await bee.put('w' + n++, n) })()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const run = await capture()
  writing = false
  await writer
  const reclaim = run.find((r) => r.core.name === 'reclaim-meta')
  t.is(b4a.toString(await bee.core.treeHash(reclaim.now.length), 'hex'), reclaim.now.treeHash, 'the hash the cut recorded is the hash at that length')
  const store = await restoredStore(t)
  await applyRun(store, run)
  await matches(t, store, run)
  await bee.close()
})

test('a tampered part is refused', async (t) => {
  await freshPeer(t, { displayName: 'Tamper' })
  const run = await capture()
  const profile = run.find((r) => r.core.role === CORE_ROLE.PROFILE)
  const { records } = decodePart(profile.buffers[0])
  const store = await restoredStore(t)
  const target = store.get({ key: b4a.from(profile.core.key, 'hex') })
  await target.ready()
  await applyRecord(target, records[0])
  const block = b4a.from(records[1])
  block[block.byteLength - 1] ^= 0xff
  await t.exception(applyRecord(target, block), /BACKUP_CORRUPT|refused|decode/)
  await target.close()
})
