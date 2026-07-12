import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { PARTIAL_SUFFIX as PARTIAL } from '../../src/shared/transfer/partial-suffix.js'

// overlayEnabled for both peers; a short foreign poll so resume re-fetches
// promptly instead of waiting the 30s production cadence.
const OWNER_FLAGS = { overlayEnabled: true }
const MIRROR_FLAGS = { overlayEnabled: true, foreignPollIntervalMs: 1500 }

async function waitForSize (file, want, ms = scaled(60000)) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try { if (fs.statSync(file).size === want) return } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`file ${file} never reached ${want} bytes within ${ms}ms`)
}

// REGRESSION (FIX-128): pausing a mirror must abort the file the overlay mirror
// is fetching right now, not just stop launching the next one. The owner shares a
// large file; the mirror pauses on the first mid-download progress event. Before
// the fix the in-flight overlay fetch ran to completion (the final file appeared);
// after it, the download stops with a partial kept, and resume completes it.
test('REGRESSION (FIX-128): pausing a mirror aborts the in-flight download; resume completes it',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags: OWNER_FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: MIRROR_FLAGS })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Bulk', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    const SIZE = 96 * 1024 * 1024
    fs.writeFileSync(path.join(folder, 'big.bin'), patternedBytes(SIZE, 7))
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    await B.until('share:list', { spaceId }, (l) => Array.isArray(l) && l.some((s) => s.id === share.id), { ms: 60000 })

    const dest = mkTmpDir(t)
    const destFile = path.join(dest, 'big.bin')

    // Pause the instant the mirror reports partial bytes — well before the 96 MiB
    // file could finish, so we are unambiguously mid-download.
    const firstProgress = B.waitFor('event:decoration',
      (m) => m.channel === 'transfer' && m.key === share.id + ':big.bin' && !m.done && m.bytes > 0 && (!m.total || m.bytes < m.total), 90000)
    await B.request('foreign-folder:mount', { spaceId, ownerKey: aKey, shareId: share.id, mountPath: dest })
    await firstProgress
    await B.request('foreign-folder:set-enabled', { spaceId, shareId: share.id, enabled: false })

    // The in-flight download must stop: without the fix the fetch runs to
    // completion and the final file appears within a second or two. Give it ample
    // time to (wrongly) finish, then assert it did not.
    await new Promise((r) => setTimeout(r, scaled(6000)))
    t.absent(fs.existsSync(destFile), 'paused mirror did not complete the in-flight file')
    t.ok(fs.existsSync(destFile + PARTIAL), 'partial kept on disk for resume')

    // Resume → the next poll tick re-fetches from the kept partial and completes.
    await B.request('foreign-folder:set-enabled', { spaceId, shareId: share.id, enabled: true })
    await waitForSize(destFile, SIZE)
    t.is(fs.statSync(destFile).size, SIZE, 'resume completed the file')
    t.absent(fs.existsSync(destFile + PARTIAL), 'partial renamed to the final file on completion')
  })
