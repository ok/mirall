import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, mkStoreDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// The folder twin of loose-cancel-discard: files:cancel-download on a folder file's transfer id,
// from a live transfer, clears the partial and returns the row to 'remote'; a re-download afterwards
// completes byte-exact. Folder and loose downloads run on one engine, so this is the proof that a
// folder id reaches it end to end. The paused-then-discard case is folder-overlay-pause-resume's.
const sleep = (ms) => new Promise((r) => setTimeout(r, scaled(ms)))

async function setup(t, name, seed) {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkStoreDir(t) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t) })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).personKey

  const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
  const folder = mkTmpDir(t)
  const bytes = patternedBytes(8 * 1024 * 1024, seed)
  fs.writeFileSync(path.join(folder, name), bytes)
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  const listing = { spaceId, ownerKey: aKey, shareId: share.id }
  const rowIs = (status) => (list) => Array.isArray(list?.entries) && list.entries.some((e) => e.relPath === name && e.status === status)
  await B.until('share:list-files', listing, rowIs('remote'), { ms: 60000 })
  return { A, B, spaceId, aKey, share, bytes, listing, rowIs }
}

async function startFlowing(B, ctx, name) {
  const flowing = new Promise((resolve) => {
    B.on('event:decoration', (m) => {
      if (m.channel !== 'transfer' || m.key !== ctx.share.id + ':' + name || m.done) return
      if (m.bytes > 0) resolve()
    })
  })
  const { transferId } = await B.request('share:read-file', { spaceId: ctx.spaceId, ownerKey: ctx.aKey, shareId: ctx.share.id, relPath: name })
  await flowing
  return transferId
}

const onDisk = (dir, stem) => fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).includes(stem))

test('folder cancel mid-download: partial discarded, row back to remote, nothing on disk',
  { timeout: scaled(150000) }, async (t) => {
    const ctx = await setup(t, 'lump.bin', 17)
    const { A, B } = ctx
    const transferId = await startFlowing(B, ctx, 'lump.bin')
    t.ok(transferId, 'transferId from the share:read-file response')

    await B.request('files:cancel-download', { transferId })
    await B.until('share:list-files', ctx.listing, ctx.rowIs('remote'), { ms: 30000 })
    await sleep(1000)
    t.alike(onDisk(B.downloads, 'lump'), [], 'no partial or final file left after cancel')
    A.kill()
  })

test('folder cancel then re-download: completes byte-exact with no stale partial',
  { timeout: scaled(180000) }, async (t) => {
    const ctx = await setup(t, 'retry.bin', 59)
    const { A, B } = ctx
    const transferId = await startFlowing(B, ctx, 'retry.bin')

    await B.request('files:cancel-download', { transferId })
    await B.until('share:list-files', ctx.listing, ctx.rowIs('remote'), { ms: 30000 })

    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/Vault/retry.bin', 120000)
    await B.request('share:read-file', { spaceId: ctx.spaceId, ownerKey: ctx.aKey, shareId: ctx.share.id, relPath: 'retry.bin' })
    const completion = await done
    t.ok(fs.readFileSync(completion.localPath).equals(ctx.bytes), 're-downloaded file is byte-exact')
    t.ok(!completion.localPath.endsWith('.mirall.part'), 'finalised, not a partial')
    t.is(completion.localPath, path.join(ctx.B.downloads, 'Vault', 'retry.bin'), 'under its folder\'s name')
    A.kill()
  })
