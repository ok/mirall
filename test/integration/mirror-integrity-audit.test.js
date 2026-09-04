import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { materializeCatalogFile, unmountForeignFolder } from '../../src/shared/folders/foreign-folders.js'
import { createForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { queryAudit, flushAudit } from '../../src/shared/audit/audit-log.js'

// src/shared/folders/ contained ZERO record( calls: a mirror holder serving bytes that fail their
// advertised hash produced a console warning and nothing else. Everything else the mirror does per
// file stays unrecorded on purpose (contract/audit-kinds.js) — these pin both halves.

const OWNER = 'o'.repeat(64)
const SHARE = 'sh-mirror'

async function rows (kind) {
  await flushAudit()
  const { entries } = await queryAudit({ limit: 100 })
  return kind ? entries.filter((e) => e.kind === kind) : entries
}

async function integrityRows ({ tries = 40 } = {}) {
  for (let i = 0; i < tries; i++) {
    const found = await rows('security.integrity_failure')
    if (found.length) return found
    await new Promise((r) => setTimeout(r, 25))
  }
  return await rows('security.integrity_failure')
}

const quiet = () => new Promise((r) => setTimeout(r, 200))

async function setup (t) {
  const ctx = await freshPeer(t)
  const space = await createSpace('Design Team')
  const mountPath = ctx.tmpDir('mirror')
  const mount = {
    spaceId: space.spaceId, shareId: SHARE, ownerKey: OWNER,
    mountPath, enabled: true, status: 'active', syncedPaths: [],
  }
  await createForeignMount(mount)
  const share = { id: SHARE, name: 'Brand Assets', owner: OWNER, spaceId: space.spaceId }
  return { ctx, space, mount, share, mountPath }
}

const entry = (over = {}) => ({ relPath: 'a/report.pdf', contentHash: 'h1'.repeat(32), size: 900, ...over })

function throwsWith (code, message) {
  return async () => {
    const err = new Error(message)
    err.code = code
    throw err
  }
}

// REGRESSION (FIX-D11-4: the mirror caught EHASHMISMATCH and answered with a log.warn — not
// exported, not searchable, not retained, invisible to the user — while the same event on a loose
// file recorded security.integrity_failure.)
test('REGRESSION (FIX-D11-4): a mirror hash mismatch records security.integrity_failure', async (t) => {
  const { mount, share, space } = await setup(t)
  getOverlay().fetchFile = throwsWith('EHASHMISMATCH', 'hash mismatch')

  await materializeCatalogFile(mount, share, entry())
  const found = await integrityRows()

  t.is(found.length, 1)
  if (!found.length) return
  t.is(found[0].target.name, 'report.pdf', 'the file is named in the row')
  t.is(found[0].subject.folder, 'Brand Assets', 'and the folder it was mirroring')
  t.is(found[0].subject.ownerKey, OWNER, 'the row names WHICH member served the bad bytes')
  t.is(found[0].space.name, 'Design Team', 'snapshotted — the row outlives the space')
  t.is(found[0].category, 'security')
  t.is(found[0].outcome, 'error')
  t.is(found[0].space.id, space.spaceId)
})

test('five ticks against the same bad file record exactly one row', async (t) => {
  const { mount, share } = await setup(t)
  getOverlay().fetchFile = throwsWith('EHASHMISMATCH', 'hash mismatch')

  for (let i = 0; i < 5; i++) await materializeCatalogFile(mount, share, entry())
  await quiet()

  t.is((await rows('security.integrity_failure')).length, 1,
    'a 30s poll must not turn one fact into thousands of rows and starve the rate budget')
})

test('a re-publish under a new hash is a new claim', async (t) => {
  const { mount, share } = await setup(t)
  getOverlay().fetchFile = throwsWith('EHASHMISMATCH', 'hash mismatch')

  await materializeCatalogFile(mount, share, entry({ contentHash: 'a'.repeat(64) }))
  await materializeCatalogFile(mount, share, entry({ contentHash: 'b'.repeat(64) }))
  await quiet()

  t.is((await rows('security.integrity_failure')).length, 2, 'different bytes advertised, failed again')
})

test('two different bad files record two rows', async (t) => {
  const { mount, share } = await setup(t)
  getOverlay().fetchFile = throwsWith('EHASHMISMATCH', 'hash mismatch')

  await materializeCatalogFile(mount, share, entry({ relPath: 'one.bin' }))
  await materializeCatalogFile(mount, share, entry({ relPath: 'two.bin' }))
  await quiet()

  t.is((await rows('security.integrity_failure')).length, 2)
})

test('a local disk fault records nothing — it is not a peer act', async (t) => {
  const { mount, share } = await setup(t)
  getOverlay().fetchFile = throwsWith('ENOSPC', 'no space left on device')

  await materializeCatalogFile(mount, share, entry())
  await quiet()

  t.is((await rows('security.integrity_failure')).length, 0, 'our full disk must never blame a holder')
  const after = await getForeignMount(mount.spaceId, mount.shareId)
  t.is(after.enabled, false, 'the mount paused instead')
})

test('a mirror fetch that finds no holder records nothing', async (t) => {
  const { mount, share } = await setup(t)
  getOverlay().fetchFile = async () => null

  await materializeCatalogFile(mount, share, entry())
  await quiet()

  t.is((await rows()).length, 0, 'per-file folder sync is deliberately unrecorded')
})

test('a mirror fetch that succeeds records nothing', async (t) => {
  const { mount, share, mountPath } = await setup(t)
  const dest = path.join(mountPath, 'a', 'report.pdf')
  getOverlay().fetchFile = async (hash, opts) => {
    fs.mkdirSync(path.dirname(opts.destPath), { recursive: true })
    fs.writeFileSync(opts.destPath, 'ok')
    return { destPath: opts.destPath, local: false, size: 2 }
  }

  const outcome = await materializeCatalogFile(mount, share, entry())
  await quiet()

  t.is(outcome, 'present', 'the file landed')
  t.ok(fs.existsSync(dest))
  t.is((await rows()).length, 0, 'a 5,000-file mirror pass must not write 5,000 rows')
})

test('unmounting re-arms the memo — a remount is a fresh session', async (t) => {
  const { mount, share } = await setup(t)
  getOverlay().fetchFile = throwsWith('EHASHMISMATCH', 'hash mismatch')

  await materializeCatalogFile(mount, share, entry())
  await quiet()
  await unmountForeignFolder(mount.spaceId, mount.shareId)
  await createForeignMount(mount)
  await materializeCatalogFile(mount, share, entry())
  await quiet()

  t.is((await rows('security.integrity_failure')).length, 2,
    'the user re-pointed the mount and deserves to be told the folder is still corrupt')
})
