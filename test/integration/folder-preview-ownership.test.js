import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { registerFolderPreview } from '../../src/worker/ipc/folder-preview.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { createCancellation } from '../../src/shared/core/cancellation.js'
import { CODES } from '../../src/shared/contract/errors.js'

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

// A rejection as a value, so a scan that ends before the test awaits it is never an unhandled
// rejection.
const failure = (p) => p.then(() => null, (e) => e)

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

// The next three drive one client reusing an id while its scan is still running. Frames are
// attributed by `total`: the superseded scan walks the larger tree and its successor the smaller
// one, so a frame's total names the scan that sent it.
test('REGRESSION (FIX-500: a second preview under a running id supersedes the first)', async (t) => {
  const { fake, noLeak } = harness()
  const large = tree(t, 40)
  const small = tree(t, 3)
  let second = null
  let from = 0

  const first = failure(previewWith(fake, {
    client: CLIENT_A,
    previewId: 'pv-1-s1',
    mountPath: large,
    during: () => {
      from = fake.events.length
      second = fake.call('owned-folder:preview', { spaceId: 's1', mountPath: small, previewId: 'pv-1-s1' }, { client: CLIENT_A })
    },
  }))

  const ended = await first
  t.is(ended?.code, CODES.PREVIEW_CANCELLED, 'the first scan is ended as cancelled')
  t.ok(/superseded/.test(ended?.message ?? ''), 'and its error says why')
  t.ok(await second, 'the newest request wins')
  const after = fake.events.slice(from).filter((f) => f.type === 'event:owned-folder-preview-progress')
  t.ok(after.length > 0, 'the second scan reported progress')
  t.ok(after.every((f) => f.payload.total === 3), 'every frame under the id after the supersede is the second scan’s')
  noLeak(t)
})

test('a cancel after the supersede stops the second scan, and nothing under the id keeps running', async (t) => {
  const { fake, noLeak } = harness()
  const large = tree(t, 40)
  const small = tree(t, 3)
  let second = null
  // Fired from the SECOND scan's first frame, so the cancel lands on a scan that is running.
  const unsub = fake.onEmit((f) => {
    if (f.type !== 'event:owned-folder-preview-progress' || f.payload.total !== 3) return
    unsub()
    void fake.call('owned-folder:cancel-preview', { previewId: 'pv-1-s1' }, { client: CLIENT_A })
  })

  const first = failure(previewWith(fake, {
    client: CLIENT_A,
    previewId: 'pv-1-s1',
    mountPath: large,
    during: () => {
      second = failure(fake.call('owned-folder:preview', { spaceId: 's1', mountPath: small, previewId: 'pv-1-s1' }, { client: CLIENT_A }))
    },
  }))

  t.is((await first)?.code, CODES.PREVIEW_CANCELLED, 'the first scan was superseded')
  t.is((await second)?.code, CODES.PREVIEW_CANCELLED, 'the cancel reached the second scan')
  noLeak(t)
})

// The foreign scan reports `enumerating` on entry, before any await, so the second request is
// issued from that frame. With no store, the owner's listing reads as unknown and the scan ends
// at its first checkpoint either way — the first as cancelled, the second with an answer.
test('REGRESSION (FIX-500: a foreign preview under a running id supersedes the first too)', async (t) => {
  const { fake, noLeak } = harness()
  const args = { spaceId: 's1', ownerKey: 'ff'.repeat(32), shareId: 'sh1', mountPath: tree(t, 3), previewId: 'fpv-1-s1' }
  let second = null
  let fired = false
  const unsub = fake.onEmit(() => {
    if (fired) return
    fired = true
    second = fake.call('foreign-folder:preview', args, { client: CLIENT_A })
  })

  const first = await failure(fake.call('foreign-folder:preview', args, { client: CLIENT_A }).finally(unsub))
  t.is(first?.code, CODES.PREVIEW_CANCELLED, 'the first scan is ended as cancelled')
  t.ok(await second, 'the newest request completes')
  noLeak(t)
})
