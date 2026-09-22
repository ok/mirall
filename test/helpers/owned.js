import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from './store.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { createOwnedMount, createForeignMount } from '../../src/shared/folders/mount-store.js'
import { runPublishPass } from '../../src/shared/folders/owned-pass.js'
import { listOwnShare, ownCatalogKeyHex } from '../../src/shared/shares/own-catalog.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'

// Create a space + an overlay owned-folder share owned by this peer + its mount dir.
// Overlay is the only content backend, so the share is stamped overlay and the
// overlay instance is brought up in-process (no second peer).
export async function setupOwnedShare(t, { name = 'Notes', files = null } = {}) {
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true })
  const ctx = await freshPeer(t)

  const space = await createSpace('Aurora')
  const share = {
    id: generateShareId(),
    type: 'owned-folder',
    name,
    owner: getLocalPublicKeyHex(),
    contentMode: 'overlay',
    catalogKey: await ownCatalogKeyHex(space.spaceId),
    createdAt: Date.now(),
  }
  await publishShare(space.spaceId, share)
  const mountPath = ctx.tmpDir('mount')
  await createOwnedMount({ spaceId: space.spaceId, shareId: share.id, mountPath, ignore: [], createdAt: Date.now() })
  writeFiles(mountPath, files)
  return { ...ctx, spaceId: space.spaceId, share, mountPath }
}

function writeFiles(root, files) {
  for (const [rel, contents] of Object.entries(files ?? {})) {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, contents)
  }
}

// Publish an overlay owned share with files AND mount it back on the SAME peer as a
// "foreign" mirror. With no second peer the mirror's catalog read + content fetch are
// stubbed: listPeerWithMeta returns the owner's own catalog entries, and overlay.fetchFile copies
// the owner's source file to the requested dest — so the shared materialize scaffolding
// (initialMaterializeScan / runMaterializeTick) still runs in-process on the overlay path.
export async function setupSelfMirror(t, { name = 'Media', files = { 'note.txt': 'hello mirror' } } = {}) {
  const ctx = await setupOwnedShare(t, { name, files })
  await runPublishPass(ctx.spaceId, ctx.share.id, ctx.mountPath, [])

  // The mirror lists from the owner's catalog and fetches by content hash; stub both
  // so the materialize path runs without a second peer. `listing` lets a test shape the read the
  // mirror sees — notably a truncated, non-empty one (complete:false), which is what a drain that
  // timed out mid-catalog looks like.
  const listing = { truncateAfter: 0, complete: true }
  const origListPeerWithMeta = overlayBackend.listPeerWithMeta
  overlayBackend.listPeerWithMeta = async (spaceId, share) => {
    const out = []
    for await (const e of listOwnShare(spaceId, share.id)) {
      out.push({ relPath: e.relPath, contentHash: e.contentHash, size: e.size })
    }
    const entries = listing.truncateAfter > 0 ? out.slice(0, listing.truncateAfter) : out
    return { entries, complete: listing.complete, total: out.length, totalBytes: 0 }
  }
  t.teardown(() => { overlayBackend.listPeerWithMeta = origListPeerWithMeta })

  const overlay = getOverlay()
  const origFetch = overlay.fetchFile
  overlay.fetchFile = async (contentHash, { destPath } = {}) => {
    // Map the requested hash back to its source file via the owner's catalog.
    for await (const e of listOwnShare(ctx.spaceId, ctx.share.id)) {
      if (e.contentHash === contentHash) {
        const src = path.join(ctx.mountPath, ...e.relPath.split('/'))
        try { fs.copyFileSync(src, destPath) } catch { return null }
        return { destPath }
      }
    }
    return null
  }
  t.teardown(() => { overlay.fetchFile = origFetch })

  const mirrorPath = ctx.tmpDir('mirror')
  const mount = {
    spaceId: ctx.spaceId,
    shareId: ctx.share.id,
    ownerKey: ctx.share.owner,
    mountPath: mirrorPath,
    enabled: true,
    attachedAt: Date.now(),
    status: 'scanning',
  }
  await createForeignMount(mount)
  return { ...ctx, mirrorPath, mount, listing }
}

// Counts the mirror's catalog reads and pins the catalog version, so a converged mirror can skip.
// The listing COUNT is the walk assertion: a wall-time or CPU measure could not go red, and the
// property under test is "no work was issued", not "the work was fast". `state.version` is the
// version the next tick reads; move it to stage an owner append.
export function instrumentWalks(t, { version = 1 } = {}) {
  const state = { listings: 0, version }
  const origList = overlayBackend.listPeerWithMeta
  const origVersion = overlayBackend.catalogVersion
  overlayBackend.listPeerWithMeta = async (...a) => { state.listings++; return await origList(...a) }
  overlayBackend.catalogVersion = async () => state.version
  t.teardown(() => {
    overlayBackend.listPeerWithMeta = origList
    overlayBackend.catalogVersion = origVersion
  })
  return state
}

export async function listRelPaths(share, spaceId) {
  const out = []
  for await (const e of listOwnShare(spaceId, share.id)) out.push(e.relPath)
  return out.sort()
}
