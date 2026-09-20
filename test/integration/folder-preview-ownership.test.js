import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { registerFolderPreview } from '../../src/worker/ipc/folder-preview.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { createCancellation } from '../../src/shared/core/cancellation.js'

// A preview id is minted by the caller from a sequence that restarts at 1 (`pv-1-<spaceId>`), so
// across clients the ids collide by construction. These drive the real handlers against a real
// temp tree; the cancel is fired from INSIDE a progress frame, because walk-disk's stat pass is
// synchronous — there is no later tick to race from, and no sleep to guess at.
const CLIENT_A = { id: 1, trust: 'host' }
const CLIENT_B = { id: 2, trust: 'host' }

function tree(t, files = 40) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-preview-own-'))
  for (let i = 0; i < files; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x')
  t.teardown(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  return dir
}

// brittle forbids assertions in teardown, so the leak check is an explicit line in each test.
function harness() {
  const fake = createFakeIpc()
  const api = registerFolderPreview(fake.ipc)
  return { fake, api, noLeak: (t) => t.is(api._previewCount(), 0, 'the registry is empty afterwards') }
}

// Runs an owned preview, calling `during` once, on the first progress frame.
function previewWith(fake, { client, previewId, mountPath, during }) {
  let fired = false
  const unsub = fake.onEmit(() => {
    if (fired) return
    fired = true
    during?.()
  })
  return fake.call('owned-folder:preview', { spaceId: 's1', mountPath, previewId }, { client })
    .finally(unsub)
}

test('REGRESSION (FIX-403-2): a client cannot cancel another client’s preview', async (t) => {
  const { fake, noLeak } = harness()
  const mountPath = tree(t)
  let reply = null

  const result = await previewWith(fake, {
    client: CLIENT_A,
    previewId: 'pv-1-s1',
    mountPath,
    // B mints the same id from its own sequence and asks to cancel it.
    during: () => { reply = fake.call('owned-folder:cancel-preview', { previewId: 'pv-1-s1' }, { client: CLIENT_B }) },
  })

  t.ok(result, 'A’s scan ran to completion')
  t.alike(await reply, { ok: true }, 'B is still answered — a racing cancel always is')
  noLeak(t)
})

test('a client cancels its own preview', async (t) => {
  const { fake, noLeak } = harness()
  const mountPath = tree(t)

  await t.exception(previewWith(fake, {
    client: CLIENT_A,
    previewId: 'pv-1-s1',
    mountPath,
    during: () => { void fake.call('owned-folder:cancel-preview', { previewId: 'pv-1-s1' }, { client: CLIENT_A }) },
  }), /cancel/i)
  noLeak(t)
})

test('two clients may hold the same preview id at once', async (t) => {
  const { fake, noLeak } = harness()
  const mountPath = tree(t)

  let b = null
  const a = previewWith(fake, {
    client: CLIENT_A,
    previewId: 'pv-1-s1',
    mountPath,
    during: () => {
      // B's identically-named preview starts while A's is in flight, and neither displaces the other.
      b = fake.call('owned-folder:preview', { spaceId: 's1', mountPath, previewId: 'pv-1-s1' }, { client: CLIENT_B })
    },
  })
  t.ok(await a, 'A finished')
  t.ok(await b, 'and so did B, under the same id')
  noLeak(t)
})

test('a disconnect aborts that client’s previews and only that client’s', async (t) => {
  const { fake, noLeak } = harness()
  const mountPath = tree(t)

  await t.exception(previewWith(fake, {
    client: CLIENT_A,
    previewId: 'pv-1-s1',
    mountPath,
    during: () => fake.disconnect(CLIENT_A),
  }), /cancel/i, 'A’s own scan is abandoned with it')

  const survivor = await previewWith(fake, {
    client: CLIENT_B,
    previewId: 'pv-1-s1',
    mountPath,
    during: () => fake.disconnect(CLIENT_A),
  })
  t.ok(survivor, 'B is untouched by A going away')
  noLeak(t)
})

test('progress frames are addressed to the client that asked', async (t) => {
  const { fake } = harness()
  await previewWith(fake, { client: CLIENT_B, previewId: 'pv-9-s1', mountPath: tree(t, 3) })
  const frames = fake.emitted('event:owned-folder-preview-progress')
  t.ok(frames.length > 0)
  t.ok(frames.every((f) => f.to === CLIENT_B), 'every frame names its caller, none is broadcast')
  t.ok(frames.every((f) => f.payload.previewId === 'pv-9-s1'))
})

test('a preview with no id takes no slot but still ends with its request', async (t) => {
  const { fake, api } = harness()
  const mountPath = tree(t)
  // The real token, so this is the signal the router would deliver on a disconnect or a deadline.
  // Aborted up front rather than mid-scan: an unnamed preview reports no progress, so it offers no
  // frame to interleave with — and the walk checks the signal on its first entry either way.
  const token = createCancellation()
  token.abort(new Error('client went away'))

  const running = fake.call('owned-folder:preview', { spaceId: 's1', mountPath }, { client: CLIENT_A, signal: token.signal })
  t.is(api._previewCount(), 0, 'nothing to register — an unnamed preview cannot be cancelled by id')
  await t.exception(running, /cancel/i, 'but the request’s own token still reaches the scan')
})
