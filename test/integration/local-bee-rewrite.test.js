import test from 'brittle'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { freshDurable } from '../helpers/store.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { writeFileAtomic } from '../../src/shared/core/atomic-file.js'
import {
  openStore, getStore, setMasterSecret, createLocalBee, createLocalBeeScratch, hasLocalBeeCore, LOCAL_BEE_NAMES,
} from '../../src/shared/core/store.js'
import { compactStore } from '../../src/shared/storage/compaction.js'
import {
  maintainLocalBees, REWRITE_STATE_FILE, REWRITE_INCOMPLETE, _failRefillForTests,
} from '../../src/shared/storage/local-bee-rewrite.js'
import {
  createForeignMount, createOwnedMount, getForeignMount, getOwnedMount, mutateForeignMount,
} from '../../src/shared/folders/mount-store.js'
import { bootDurable } from '../../src/worker/boot.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { mutateSpace, listSpaces } from '../../src/shared/spaces/space.js'
import { markDownloaded, getDownloadedPath } from '../../src/shared/transfer/files.js'
import { recordPending, getPendingFor } from '../../src/shared/transfer/pending-transfers.js'
import { setAuditConfig, getAuditConfig } from '../../src/shared/audit/audit-log.js'

function dirSize(dir) {
  let total = 0
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    total += st.isDirectory() ? dirSize(p) : st.size
  }
  return total
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const PATHS = Array.from({ length: 1494 }, (_, i) => `Folder ${i % 40}/sub/file-number-${i}.jpg`)
const MIRROR = { spaceId: 's1', shareId: 'm1', syncedPaths: PATHS, status: 'synced' }
const OWNED = { spaceId: 's1', shareId: 'o1', status: 'idle' }
const MOUNTS = 'mounts-meta'

// Each put carries the whole record and differs from the one before, so N calls append N copies of a
// record whose live value is one.
async function bootWithMirrors(t, times, mirror = (i) => ({ ...MIRROR, tick: i % 2 })) {
  const masterSecret = crypto.randomBytes(32)
  const first = await freshDurable(t, { masterSecret, displayName: null })
  for (let i = 0; i < times; i++) await createForeignMount(mirror(i))
  await createOwnedMount(OWNED)
  await first.tier.close()
  return { storage: first.storage, masterSecret, before: dirSize(first.storage) }
}

function reboot(t, { storage, masterSecret }) {
  return freshDurable(t, { storage, masterSecret, displayName: null })
}

function writeState(storage, state) {
  return writeFileAtomic(path.join(storage, REWRITE_STATE_FILE), b4a.from(JSON.stringify({ v: 1, measured: {}, ...state })))
}

function readState(storage) {
  const file = path.join(storage, REWRITE_STATE_FILE)
  return fs.existsSync(file) ? JSON.parse(b4a.toString(fs.readFileSync(file))) : null
}

async function listDks() {
  const out = []
  for await (const dk of getStore().list()) out.push(b4a.toString(dk, 'hex'))
  return out.sort()
}

// Opens the store bare, as the durable tier would before any holder, to build an on-disk state.
async function withBareStore({ storage, masterSecret }, fn) {
  await openStore(storage)
  setMasterSecret(masterSecret)
  try {
    await fn()
  } finally {
    await getStore().close()
    setMasterSecret(null)
  }
}

async function copyInto(from, to, { limit = Infinity } = {}) {
  let n = 0
  for await (const { key, value } of from.createReadStream()) {
    if (n++ >= limit) break
    await to.put(key, value)
  }
}

test('REGRESSION (#498): a repeated mirror record is rewritten at boot, freeing its bytes and keeping every record', async (t) => {
  const seeded = await bootWithMirrors(t, 1000)
  const { tier, storage } = await reboot(t, seeded)

  t.alike(tier.localBees.rewritten.map((r) => r.name), [MOUNTS], 'mounts-meta was rewritten')
  t.ok(tier.localBees.compact, 'and the boot is told to compact')
  await compactStore()
  const freed = seeded.before - dirSize(storage)
  t.ok(freed > 40e6, 'freed ' + freed + ' bytes')

  t.is((await getForeignMount('s1', 'm1')).syncedPaths.length, PATHS.length, 'the mirror record survives')
  t.is((await getOwnedMount('s1', 'o1')).status, 'idle', 'the owned record survives')
  const next = await mutateForeignMount('s1', 'm1', (m) => ({ ...m, status: 'paused' }))
  t.is(next?.status, 'paused', 'a serialized write commits against the rewritten core')
  t.is(readState(storage).restoring, null, 'no rewrite is left marked')
})

test('the rewrite keeps the bee under its own key', async (t) => {
  const seeded = await bootWithMirrors(t, 500)
  let before = null
  await withBareStore(seeded, async () => {
    const bee = createLocalBee(MOUNTS)
    await bee.ready()
    before = b4a.toString(bee.core.discoveryKey, 'hex')
    await bee.close()
  })
  await reboot(t, seeded)
  const bee = createLocalBee(MOUNTS)
  await bee.ready()
  t.is(b4a.toString(bee.core.discoveryKey, 'hex'), before, 'same discovery key: an older build opens the same core')
  t.ok(bee.core.length <= 4, 'holding only its live entries (' + bee.core.length + ' blocks)')
  t.is(bee.core.fork, 1, 'truncated once')
  await bee.close()
})

test('a boot with nothing due rewrites nothing and creates no core', async (t) => {
  const masterSecret = crypto.randomBytes(32)
  const first = await freshDurable(t, { masterSecret, displayName: null })
  const dks = await listDks()
  await first.tier.close()

  const { tier } = await reboot(t, { storage: first.storage, masterSecret })
  t.alike(tier.localBees, { compact: false, rewritten: [] })
  t.alike(await listDks(), dks, 'the same cores before and after')
  for (const name of LOCAL_BEE_NAMES) t.absent(await hasLocalBeeCore(name, { scratch: true }), name + ' has no scratch')
})

test('a bee under the floor is never scanned', async (t) => {
  const seeded = await bootWithMirrors(t, 100)
  const { tier, storage } = await reboot(t, seeded)
  t.is(tier.localBees.rewritten.length, 0)
  t.absent(readState(storage)?.measured?.[MOUNTS], 'no verdict recorded, so no scan ran')
})

test('a big bee of live data is scanned once, then not again until it grows', async (t) => {
  const seeded = await bootWithMirrors(t, 500, (i) => ({ ...MIRROR, shareId: 'm' + i }))
  const first = await reboot(t, seeded)
  t.is(first.tier.localBees.rewritten.length, 0, 'live data is not history')
  const verdict = readState(first.storage).measured[MOUNTS]
  t.ok(verdict?.coreBytes > 20e6, 'the verdict is recorded')
  await first.tier.close()

  await reboot(t, seeded)
  t.alike(readState(seeded.storage).measured[MOUNTS], verdict, 'the next boot did not scan again')
})

test('a crash after the marker is restored from the scratch at the next boot', async (t) => {
  const seeded = await bootWithMirrors(t, 300)
  await withBareStore(seeded, async () => {
    const bee = createLocalBee(MOUNTS)
    const scratch = createLocalBeeScratch(MOUNTS)
    await bee.ready()
    await scratch.ready()
    await copyInto(bee, scratch)
    await writeState(seeded.storage, { restoring: { name: MOUNTS, fork: bee.core.fork, scratchLength: scratch.core.length } })
    await bee.core.truncate(0)
    await copyInto(scratch, bee, { limit: 1 })
    await scratch.close()
    await bee.close()
  })

  const { tier, storage } = await reboot(t, seeded)
  t.ok(tier.localBees.compact, 'the restore purged the scratch')
  t.is((await getForeignMount('s1', 'm1')).syncedPaths.length, PATHS.length, 'the mirror record is back')
  t.is((await getOwnedMount('s1', 'o1')).status, 'idle', 'and the record the partial refill missed')
  t.is(readState(storage).restoring, null, 'the marker is cleared')
  t.absent(await hasLocalBeeCore(MOUNTS, { scratch: true }), 'the scratch is gone')
})

test('a scratch without a marker is purged and the bee is left as it was', async (t) => {
  const seeded = await bootWithMirrors(t, 1)
  await withBareStore(seeded, async () => {
    const scratch = createLocalBeeScratch(MOUNTS)
    await scratch.put('foreign-folder-mount/s1/m1', { ...MIRROR, status: 'from-scratch' })
    await scratch.close()
  })
  await reboot(t, seeded)
  t.is((await getForeignMount('s1', 'm1')).status, 'synced', 'the bee kept its own value')
  t.absent(await hasLocalBeeCore(MOUNTS, { scratch: true }), 'the scratch is gone')
})

test('a marker without its scratch is cleared and the boot goes on', async (t) => {
  const seeded = await bootWithMirrors(t, 1)
  await writeState(seeded.storage, { restoring: { name: MOUNTS, fork: 0, scratchLength: 3 } })
  const { storage } = await reboot(t, seeded)
  t.is(readState(storage).restoring, null)
  t.is((await getOwnedMount('s1', 'o1')).status, 'idle', 'the bee is untouched')
})

test('a rewrite that cannot refill fails the boot and the next boot restores the bee', async (t) => {
  const seeded = await bootWithMirrors(t, 1000)
  const config = { storage: seeded.storage, appVersion: '0.0.0-test', dev: true, verbose: false }
  let durable = null
  let failure = null
  _failRefillForTests(new Error('disk full'))
  try {
    await bootDurable(config, { ipc: createFakeIpc().ipc, log: quiet, masterSecret: seeded.masterSecret, onTier: (d) => { durable = d } })
  } catch (err) {
    failure = err
  } finally {
    await durable?.close()
  }
  t.is(failure?.code, REWRITE_INCOMPLETE, 'the boot fails visibly')
  t.is(readState(seeded.storage).restoring?.name, MOUNTS, 'the marker still names the bee')

  const { tier } = await reboot(t, seeded)
  t.ok(tier.localBees.compact, 'the next boot restored it')
  t.is((await getForeignMount('s1', 'm1')).syncedPaths.length, PATHS.length, 'the mirror record is back')
  t.is((await getOwnedMount('s1', 'o1')).status, 'idle', 'and the owned one')
})

test('a marker whose truncate never reached the disk leaves the bee as it was', async (t) => {
  const seeded = await bootWithMirrors(t, 300)
  await withBareStore(seeded, async () => {
    const bee = createLocalBee(MOUNTS)
    const scratch = createLocalBeeScratch(MOUNTS)
    await bee.ready()
    await scratch.ready()
    await copyInto(bee, scratch, { limit: 1 })
    await writeState(seeded.storage, { restoring: { name: MOUNTS, fork: bee.core.fork, scratchLength: 99 } })
    await scratch.close()
    await bee.close()
  })
  const { storage } = await reboot(t, seeded)
  t.is((await getOwnedMount('s1', 'o1')).status, 'idle', 'the record the short scratch lacks is still there')
  t.is(readState(storage).restoring, null, 'the marker is cleared')
  t.absent(await hasLocalBeeCore(MOUNTS, { scratch: true }), 'the scratch is gone')
})

test('a truncated bee whose scratch is shorter than recorded fails the boot', async (t) => {
  const seeded = await bootWithMirrors(t, 300)
  await withBareStore(seeded, async () => {
    const bee = createLocalBee(MOUNTS)
    const scratch = createLocalBeeScratch(MOUNTS)
    await bee.ready()
    await scratch.ready()
    await copyInto(bee, scratch, { limit: 1 })
    await writeState(seeded.storage, { restoring: { name: MOUNTS, fork: bee.core.fork, scratchLength: scratch.core.length + 1 } })
    await bee.core.truncate(0)
    await scratch.close()
    await bee.close()
  })
  const config = { storage: seeded.storage, appVersion: '0.0.0-test', dev: true, verbose: false }
  let durable = null
  let failure = null
  try {
    await bootDurable(config, { ipc: createFakeIpc().ipc, log: quiet, masterSecret: seeded.masterSecret, onTier: (d) => { durable = d } })
  } catch (err) {
    failure = err
  } finally {
    await durable?.close()
  }
  t.is(failure?.code, REWRITE_INCOMPLETE, 'the boot refuses to open a bee it cannot restore')
  t.is(readState(seeded.storage).restoring?.name, MOUNTS, 'the marker stays')
})

test('a pending restore is settled before another bee is rewritten', async (t) => {
  const masterSecret = crypto.randomBytes(32)
  const first = await freshDurable(t, { masterSecret })
  const { spaceId } = await createSpace('Two at once')
  const pad = 'x'.repeat(60000)
  for (let i = 0; i < 400; i++) await mutateSpace(spaceId, (s) => ({ ...s, pad, flip: i % 2 }))
  await createForeignMount(MIRROR)
  await createOwnedMount(OWNED)
  await first.tier.close()
  const seeded = { storage: first.storage, masterSecret }
  await withBareStore(seeded, async () => {
    const bee = createLocalBee(MOUNTS)
    const scratch = createLocalBeeScratch(MOUNTS)
    await bee.ready()
    await scratch.ready()
    await copyInto(bee, scratch)
    await writeState(seeded.storage, { restoring: { name: MOUNTS, fork: bee.core.fork, scratchLength: scratch.core.length } })
    await bee.core.truncate(0)
    await scratch.close()
    await bee.close()
  })

  const { tier } = await reboot(t, seeded)
  t.ok(tier.localBees.rewritten.some((r) => r.name === 'spaces-meta'), 'spaces-meta was rewritten')
  t.is((await getOwnedMount('s1', 'o1')).status, 'idle', 'and mounts-meta was restored, not dropped')
  t.is((await getForeignMount('s1', 'm1')).syncedPaths.length, PATHS.length)
})

test('an identical put appends nothing to a local bee', async (t) => {
  await freshDurable(t, { masterSecret: crypto.randomBytes(32), displayName: null })
  await createForeignMount(MIRROR)
  const bee = createLocalBee(MOUNTS)
  await bee.ready()
  const length = bee.core.length
  await createForeignMount({ ...MIRROR })
  t.is(bee.core.length, length, 'the repeated record was not stored again')
  await createForeignMount({ ...MIRROR, status: 'paused' })
  t.is(bee.core.length, length + 1, 'a changed one was')
  await bee.close()
})

test('without a master secret nothing is measured or written', async (t) => {
  const seeded = await bootWithMirrors(t, 1)
  await openStore(seeded.storage)
  t.teardown(() => getStore().close())
  setMasterSecret(null)
  t.alike(await maintainLocalBees({ log: quiet }), { compact: false, rewritten: [] })
  t.absent(fs.existsSync(path.join(seeded.storage, REWRITE_STATE_FILE)), 'no state file')
})

test('every holder reads its bee after a rewrite', async (t) => {
  const masterSecret = crypto.randomBytes(32)
  const first = await freshDurable(t, { masterSecret })
  const { spaceId } = await createSpace('Rewritten')
  await markDownloaded(spaceId, 'docs/a.txt', '/tmp/a.txt')
  await recordPending(spaceId, 'docs/b.txt', { size: 3 })
  await setAuditConfig({ retentionDays: 42 })
  // Alternating one field defeats the no-op guard, so each of these lands as history.
  const pad = 'x'.repeat(60000)
  for (let i = 0; i < 400; i++) await mutateSpace(spaceId, (s) => ({ ...s, pad, flip: i % 2 }))
  await first.tier.close()

  const { tier } = await reboot(t, { storage: first.storage, masterSecret })
  t.ok(tier.localBees.rewritten.some((r) => r.name === 'spaces-meta'), 'spaces-meta was rewritten')
  t.alike((await listSpaces()).map((s) => s.name), ['Rewritten'])
  t.is(await getDownloadedPath(spaceId, 'docs/a.txt'), '/tmp/a.txt')
  t.ok(await getPendingFor(spaceId, 'docs/b.txt'))
  t.is(getAuditConfig().retentionDays, 42)
})
