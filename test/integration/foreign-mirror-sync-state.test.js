import test from 'brittle'
import fs from 'bare-fs'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { saveForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { publishMirror, readOwnMirrors } from '../../src/shared/folders/mirror-records.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { initForeignFolders, initialMaterializeScan, setForeignEnabled, runMaterializeTick } from '../../src/shared/folders/foreign-folders.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'

const ONE_FILE = [{ relPath: 'a.bin', contentHash: 'a'.repeat(64), size: 1024 }]

// The mirrorer publishes an AUTHORITATIVE sync state into its own participation record: a
// materialize pass that leaves every catalog entry present marks the record 'synced'; a pass that
// can't fetch a file leaves it 'syncing'. This is what lets a share's owner (and any member) tell a
// fully-merged mirror from one still catching up, even while the mirrorer is offline. Deterministic:
// the overlay's fetchFile is stubbed to succeed or to find no holder.
async function setupMirror (t, { fetchResult, entries = ONE_FILE } = {}) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true })
  await initDownloads()
  await initOverlay()
  t.teardown(async () => { await teardownOverlay() })

  const spaceId = (await createSpace('Aurora')).spaceId
  const shareId = generateShareId()
  await publishShare(spaceId, {
    id: shareId, type: 'owned-folder', name: 'Mirror', owner: getLocalPublicKeyHex(),
    contentMode: 'overlay', catalogKey: 'c'.repeat(64), createdAt: Date.now(),
  })

  const origListPeer = overlayBackend.listPeer
  overlayBackend.listPeer = async () => entries
  t.teardown(() => { overlayBackend.listPeer = origListPeer })

  const overlay = getOverlay()
  const origFetch = overlay.fetchFile
  t.teardown(() => { overlay.fetchFile = origFetch })
  // The real fetchFile writes the verified bytes to destPath before resolving; mirror that so the
  // success path lands a real file (fetchResult null → no holder → the entry stays missing).
  overlay.fetchFile = async (_hash, opts) => {
    if (fetchResult && opts?.destPath) fs.writeFileSync(opts.destPath, 'x'.repeat(1024))
    return fetchResult
  }

  const fake = createFakeIpc()
  initForeignFolders(fake.ipc)

  await publishMirror(spaceId, shareId, { state: 'syncing' })
  await saveForeignMount({
    spaceId, shareId, ownerKey: getLocalPublicKeyHex(), mountPath: ctx.tmpDir('mirror'),
    enabled: true, attachedAt: Date.now(), status: 'active', syncedPaths: [],
  })
  return { spaceId, shareId, fake }
}

const stateOf = async (spaceId) => (await readOwnMirrors(spaceId))[0]?.state

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitForState (spaceId, want, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await stateOf(spaceId) === want) return want
    await delay(20)
  }
  return stateOf(spaceId)
}

test('a materialize pass that lands every file marks the mirror record synced', async (t) => {
  const { spaceId, shareId } = await setupMirror(t, { fetchResult: {} }) // truthy → the file materialized
  await initialMaterializeScan(await getForeignMount(spaceId, shareId))
  t.is(await stateOf(spaceId), 'synced', 'all present → synced')
})

test('a materialize pass that cannot fetch a file leaves the mirror record syncing', async (t) => {
  const { spaceId, shareId } = await setupMirror(t, { fetchResult: null }) // no holder → missing
  await initialMaterializeScan(await getForeignMount(spaceId, shareId))
  t.is(await stateOf(spaceId), 'syncing', 'a missing file → still syncing')
})

// REGRESSION: an empty catalog listing at mount (owner's catalog not yet replicated) must NOT
// publish 'synced' with zero files, which would falsely show a fully-merged mirror.
test('an empty catalog listing on the initial scan does not falsely settle to synced', async (t) => {
  const { spaceId, shareId } = await setupMirror(t, { fetchResult: {}, entries: [] })
  await initialMaterializeScan(await getForeignMount(spaceId, shareId))
  t.is(await stateOf(spaceId), 'syncing', 'empty listing keeps the mount-published syncing, not synced')
})

// REGRESSION: a poll/append tick must not move a paused mirror off 'paused' (the tick is a no-op on
// a disabled mount).
test('a materialize tick does not overwrite a paused mirror', async (t) => {
  const { spaceId, shareId } = await setupMirror(t, { fetchResult: {} })
  await initialMaterializeScan(await getForeignMount(spaceId, shareId))
  await setForeignEnabled(spaceId, shareId, false)
  t.is(await stateOf(spaceId), 'paused', 'paused')

  await runMaterializeTick(spaceId, shareId)
  t.is(await stateOf(spaceId), 'paused', 'tick left the paused record alone')
})

// REGRESSION: a redundant enable of an already-active mount must not blink 'synced'->'syncing'.
test('re-enabling an already-active mirror does not blink it back to syncing', async (t) => {
  const { spaceId, shareId } = await setupMirror(t, { fetchResult: {} })
  await initialMaterializeScan(await getForeignMount(spaceId, shareId))
  t.is(await stateOf(spaceId), 'synced', 'synced')

  await setForeignEnabled(spaceId, shareId, true) // redundant enable
  t.is(await stateOf(spaceId), 'synced', 'stayed synced, no spurious syncing transition')
})

// REGRESSION: a mirror-record state change must poke the renderer via a share-scoped
// event:mirrors-updated — the widget refreshes only on that event, so dropping it strands the UI.
test('a lifecycle state change emits a share-scoped event:mirrors-updated', async (t) => {
  const { spaceId, shareId, fake } = await setupMirror(t, { fetchResult: {} })
  await initialMaterializeScan(await getForeignMount(spaceId, shareId))
  fake.events.length = 0

  await setForeignEnabled(spaceId, shareId, false) // synced -> paused: a real transition
  const pokes = fake.emitted('event:mirrors-updated')
  t.ok(pokes.length > 0, 'a state change emits event:mirrors-updated')
  t.is(pokes[pokes.length - 1].payload.shareId, shareId, 'the poke carries the shareId so only the affected widget refetches')
})

// REGRESSION (FIX-MIRROR-RESUME): resuming a fully-synced mirror set the record to 'syncing' and
// then waited a whole poll interval (~30s) before a tick re-derived it. Resume now kicks an
// immediate re-evaluation tick, which settles a caught-up mirror straight back to 'synced'.
test('FIX-MIRROR-RESUME: resuming a fully-synced mirror settles back to synced, not stuck syncing', async (t) => {
  const { spaceId, shareId } = await setupMirror(t, { fetchResult: {} })
  await initialMaterializeScan(await getForeignMount(spaceId, shareId))
  t.is(await stateOf(spaceId), 'synced', 'initial scan → synced')

  await setForeignEnabled(spaceId, shareId, false)
  t.is(await stateOf(spaceId), 'paused', 'pause → paused')

  await setForeignEnabled(spaceId, shareId, true)
  t.is(await waitForState(spaceId, 'synced'), 'synced', 'resume settles back to synced (no lingering syncing blink)')
})
