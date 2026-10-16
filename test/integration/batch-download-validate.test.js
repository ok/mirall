import test from 'brittle'
import { setupOwnedShare } from '../helpers/owned.js'
import { createOwnedMounter } from '../../src/worker/owned-mount.js'
import { registerShares } from '../../src/worker/ipc/shares.js'
import { createForeignMount } from '../../src/shared/folders/mount-store.js'
import { validateArgs } from '../../src/shared/core/handler-table.js'
import { REQUESTS } from '../../src/shared/contract/requests.js'
import { BATCH_MAX_ITEMS } from '../../src/shared/contract/limits.js'
import { requestShareDownloads } from '../../src/shared/transfer/overlay/share-downloads.js'
import { LAYOUT } from '../../src/shared/transfer/overlay/download-job.js'

// What a batch request refuses before it touches a catalog: a path that escapes, a folder name
// that would escape, an own folder, a mirrored folder, and a list past the boundary cap.

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

async function withHandlers(t) {
  const ctx = await setupOwnedShare(t, { name: 'Vault', files: { 'a.txt': 'x' } })
  const mountOwnedShare = createOwnedMounter({ ipc: ctx.fake.ipc, mounts: ctx.root.mounts })
  registerShares(ctx.fake.ipc, { log: quiet, intents: ctx.root.intents, mountOwnedShare })
  return ctx
}

async function refusal(fn) {
  try { await fn() } catch (err) { return err.code ?? err.message }
  return null
}

test('a list past the cap, an empty list and an over-long item are refused by the validator', (t) => {
  const args = REQUESTS['share:read-files'].args
  const base = { ownerKey: 'o', shareId: 's', spaceId: 'sp' }
  t.ok(/exceeds/.test(validateArgs(args, { ...base, relPaths: Array.from({ length: BATCH_MAX_ITEMS + 1 }, (_, i) => 'f' + i) }) ?? ''), 'one over the cap')
  t.is(validateArgs(args, { ...base, relPaths: Array.from({ length: BATCH_MAX_ITEMS }, (_, i) => 'f' + i) }), null, 'the cap itself passes')
  t.ok(/at least/.test(validateArgs(args, { ...base, relPaths: [] }) ?? ''), 'an empty batch')
  const loose = REQUESTS['files:download-many'].args
  t.ok(/at least/.test(validateArgs(loose, { ownerKey: 'o', spaceId: 'sp', paths: [] }) ?? ''))
})

test('an own folder is refused by the handler', async (t) => {
  const ctx = await withHandlers(t)
  t.is(await refusal(() => ctx.fake.call('share:read-files', { spaceId: ctx.spaceId, ownerKey: ctx.share.owner, shareId: ctx.share.id, relPaths: ['a.txt'] })), 'INVALID_ARGUMENT')
})

test('a path that escapes refuses the whole batch', async (t) => {
  const ctx = await setupOwnedShare(t, { name: 'Vault' })
  const share = { ...ctx.share, owner: 'peer'.padEnd(64, '0') }
  t.is(await refusal(() => requestShareDownloads(ctx.spaceId, share, ['ok.txt', '../x'], { layout: LAYOUT.TREE })), 'EPATH')
})

test('a folder name that would escape is refused before any file', async (t) => {
  const ctx = await setupOwnedShare(t, { name: 'Vault' })
  const share = { ...ctx.share, name: '..', owner: 'peer'.padEnd(64, '0') }
  t.is(await refusal(() => requestShareDownloads(ctx.spaceId, share, ['a.txt'], { layout: LAYOUT.TREE })), 'EPATH')
  t.is(await refusal(() => requestShareDownloads(ctx.spaceId, { ...share, name: 'a/b' }, ['a.txt'], { layout: LAYOUT.TREE })), 'EPATH', 'a separator in the name is refused too')
})

test('a mirrored folder answers mirrored without starting anything', async (t) => {
  const ctx = await setupOwnedShare(t, { name: 'Vault' })
  const share = { ...ctx.share, owner: 'peer'.padEnd(64, '0') }
  await createForeignMount({ spaceId: ctx.spaceId, shareId: share.id, ownerKey: share.owner, mountPath: ctx.tmpDir('mirror'), enabled: true, status: 'active', attachedAt: Date.now(), syncedPaths: [] })
  t.alike(await requestShareDownloads(ctx.spaceId, share, ['a.txt'], { layout: LAYOUT.TREE }), { mirrored: true })
})
