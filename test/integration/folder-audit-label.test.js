import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare } from '../helpers/owned.js'
import { tmpDir } from '../helpers/bare-tmp.js'
import { until } from '../helpers/bare-poll.js'
import { flushAudit } from '../../src/shared/audit/audit-log.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { createOwnedMounter } from '../../src/worker/owned-mount.js'
import { shareNameOrNull } from '../../src/worker/audit-refs.js'
import { registerShares } from '../../src/worker/ipc/shares.js'
import { registerOwnedFolders } from '../../src/worker/ipc/owned-folders.js'
import { createFolderChooser } from '../../src/worker/download-folder-push.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

async function ownedShareWithHandlers(t) {
  const ctx = await setupOwnedShare(t, { name: 'Vault', files: { 'a.txt': 'x' } })
  const { fake, root } = ctx
  const mountOwnedShare = createOwnedMounter({ ipc: fake.ipc, mounts: root.mounts })
  registerShares(fake.ipc, { log: quiet, intents: root.intents, mountOwnedShare, chooseFolder: createFolderChooser({ ipc: fake.ipc, publishRevealRoots: () => {} }) })
  registerOwnedFolders(fake.ipc, { log: quiet, mounts: root.mounts, intents: root.intents, mountOwnedShare })
  return ctx
}

// The same tree at a new path, so the relocate's deep pass finds nothing to change, and waited
// for, so it does not outlive the test into teardown.
async function relocate(t, { fake, spaceId, share }) {
  const moved = tmpDir('mirall-relocate-to', t)
  fs.writeFileSync(path.join(moved, 'a.txt'), 'x')
  const scanned = new Promise((resolve) => {
    const off = fake.onEmit((frame) => {
      if (frame.type === 'event:owned-folder-scan-completed' && frame.payload.shareId === share.id) { off(); resolve() }
    })
  })
  await fake.call('owned-folder:relocate', { spaceId, shareId: share.id, mountPath: moved })
  await scanned
}

async function rowsOf(kind, search) {
  await flushAudit()
  return (await queryAudit({ kinds: [kind], search })).entries
}

const rename = ({ fake, spaceId }, shareId, name) => fake.call('share:rename', { spaceId, shareId, name })

test('REGRESSION (FIX-641: a moved folder\'s row carried no folder name, so it read "You moved the folder" and search missed it)', async (t) => {
  const ctx = await ownedShareWithHandlers(t)
  await relocate(t, ctx)

  const rows = await rowsOf('share.relocated', 'vault')
  t.is(rows.length, 1, 'searching the folder name finds the row')
  t.is(rows[0]?.target.name, 'Vault', 'the row names the folder')
})

test('a renamed folder\'s move row carries the name the user sees', async (t) => {
  const ctx = await ownedShareWithHandlers(t)
  await rename(ctx, ctx.share.id, 'Archive')
  await relocate(t, ctx)

  const rows = await rowsOf('share.relocated', 'archive')
  t.is(rows.length, 1, 'searching the current name finds the row')
  t.is(rows[0]?.target.name, 'Archive', 'not the on-disk name the rename left in place')
})

test('a renamed folder\'s delete row carries the name the user sees, on both delete paths', async (t) => {
  const ctx = await ownedShareWithHandlers(t)
  await rename(ctx, ctx.share.id, 'Archive')
  await ctx.fake.call('owned-folder:delete', { spaceId: ctx.spaceId, shareId: ctx.share.id })

  const other = { ...ctx.share, id: generateShareId(), name: 'Drafts' }
  await publishShare(ctx.spaceId, other)
  await rename(ctx, other.id, 'Sketches')
  await ctx.fake.call('share:delete', { spaceId: ctx.spaceId, shareId: other.id })

  t.alike((await rowsOf('share.deleted')).map((e) => e.target.name).sort(), ['Archive', 'Sketches'])
})

test('a folder renamed before it is mounted is mounted under the name the user sees', async (t) => {
  const ctx = await ownedShareWithHandlers(t)
  const other = { ...ctx.share, id: generateShareId(), name: 'Drafts' }
  await publishShare(ctx.spaceId, other)
  await rename(ctx, other.id, 'Sketches')
  await ctx.fake.call('owned-folder:mount', { spaceId: ctx.spaceId, shareId: other.id, mountPath: tmpDir('mirall-mount-renamed', t) })

  t.ok(await until(async () => (await rowsOf('share.mounted', 'sketches')).length === 1), 'searching the label finds the row')
})

test('a mirror row names the folder by its label', async (t) => {
  const { spaceId, share } = await setupOwnedShare(t, { name: 'Vault' })
  await publishShare(spaceId, { ...share, displayName: 'Archive' })

  t.is(await shareNameOrNull(spaceId, share.owner, share.id), 'Archive')
})
