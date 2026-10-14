import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { capture } from '../helpers/capture-console.js'
import { setVerbose } from '../helpers/runtime-verbose.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { runMaterializeTick } from '../../src/shared/folders/mirror-pass.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/overlay/index.js'

// A rejected mirror fetch, end to end: the vendor call returns the rejection rather than hanging
// anything on it, so a fault that cannot carry a property still reaches the mirror's fault policy as
// itself, and the diag that fetch opened still gets its terminal line. The per-outcome contract of
// the call itself is test/unit/call-vendor.

async function mirrorRejecting(t, fault) {
  const ctx = await freshPeer(t)
  await initOverlay()
  t.teardown(async () => { await teardownOverlay() })

  const space = await createSpace('Aurora')
  const spaceId = space.spaceId
  const shareId = generateShareId()
  await publishShare(spaceId, {
    id: shareId, type: 'owned-folder', name: 'Mirror', owner: getLocalPublicKeyHex(),
    contentMode: 'overlay', catalogKey: 'c'.repeat(64), createdAt: Date.now(),
  })
  const list = overlayBackend.listPeerWithMeta
  overlayBackend.listPeerWithMeta = async () => ({ entries: [{ relPath: 'big.bin', contentHash: 'a'.repeat(64), size: 1024 }], complete: true })
  t.teardown(() => { overlayBackend.listPeerWithMeta = list })

  const overlay = getOverlay()
  const fetchFile = overlay.fetchFile
  t.teardown(() => { overlay.fetchFile = fetchFile })
  overlay.fetchFile = async () => { throw fault }

  await createForeignMount({
    spaceId, shareId, ownerKey: getLocalPublicKeyHex(), mountPath: ctx.tmpDir('mirror'),
    enabled: true, attachedAt: Date.now(), status: 'active', syncedPaths: [],
  })
  return { spaceId, shareId }
}

// The diag's own lines for the one entry, minus its opening ones: what is left is how it closed.
function diagEnds(lines) {
  return [...lines.log, ...lines.warn]
    .filter((l) => l.startsWith('[overlay-fetch]') && l.includes('big.bin'))
    .filter((l) => !/ start: | scheduler end: /.test(l))
}

// REGRESSION (FIX-FETCH-ANNOTATE: the diag and the attempt flag were assigned onto the rejection
// unguarded. ESM is always strict, so a frozen rejection made those assignments throw a TypeError
// that REPLACED the real fault — a full disk then reached the mirror as a bug in the
// instrumentation instead of the ENOSPC that has to pause the mount.)
test('REGRESSION (FIX-FETCH-ANNOTATE): a frozen ENOSPC still pauses the mount', async (t) => {
  const frozen = Object.freeze(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }))
  const { spaceId, shareId } = await mirrorRejecting(t, frozen)
  await runMaterializeTick(spaceId, shareId)
  t.is((await getForeignMount(spaceId, shareId)).status, 'paused-enospc', 'the fault reached the pause as itself')
})

// REGRESSION (FIX-FETCH-DIAG: when the annotation could not land, the diag was dropped rather than
// settled, so the `start:` line this fetch had already logged never got its terminal
// `INCOMPLETE … gave up`.)
test('REGRESSION (FIX-FETCH-DIAG): a frozen rejection still closes its diag as failed', async (t) => {
  const frozen = Object.freeze(new Error('holder went away'))
  const { spaceId, shareId } = await mirrorRejecting(t, frozen)
  setVerbose(t, true)
  const lines = capture(t, ['log', 'warn'])
  await runMaterializeTick(spaceId, shareId)
  const ends = diagEnds(lines)
  t.is(ends.length, 1, 'closed exactly once')
  t.ok(ends[0]?.includes('INCOMPLETE'), 'as a give-up: ' + ends[0])
})

// A pause or unmount aborts the fetch with ECANCELLED, which is normal control flow: it closes as a
// stop, never as a give-up.
test('a cancelled fetch closes its diag as paused', async (t) => {
  const { spaceId, shareId } = await mirrorRejecting(t, Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }))
  setVerbose(t, true)
  const lines = capture(t, ['log', 'warn'])
  await runMaterializeTick(spaceId, shareId)
  const ends = diagEnds(lines)
  t.is(ends.length, 1, 'closed exactly once')
  t.ok(ends[0]?.includes('overlay mirror paused:'), 'as a deliberate stop: ' + ends[0])
  t.absent(lines.warn.some((l) => l.includes('INCOMPLETE')), 'with no give-up WARN')
})
