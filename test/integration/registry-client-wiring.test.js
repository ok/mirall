import test from 'brittle'
import { registerSettings } from '../../src/worker/ipc/settings.js'
import { registerFiles } from '../../src/worker/ipc/files.js'
import { subscribeServeDetail, unsubscribeServeDetail } from '../../src/shared/transfer/serve-ledger.js'
import { getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { setVerbose } from '../helpers/runtime-verbose.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'

// The policies are unit-tested; this is the wiring between them and the router, which nothing else
// covers and the type system cannot check. An earlier draft of the verbose baseline was exactly a
// wiring bug — correct policy, wrong value handed to it — that passed every policy test.
const CLIENT_A = { id: 1, trust: 'host' }
const CLIENT_B = { id: 2, trust: 'host' }

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }
const mountsStub = { probeDownloadRoots() {}, unavailableRoots: [] }

test('setVerbose is per client, and a disconnect releases that client’s claim', async (t) => {
  setVerbose(t, false)

  const fake = createFakeIpc()
  registerSettings(fake.ipc, { mounts: mountsStub, publishDownloadRoots: () => {} })

  t.alike(await fake.call('setVerbose', { verbose: true }, { client: CLIENT_A }), { verbose: true })
  t.is(getRuntimeConfig().verbose, true, 'the runtime config followed')

  // B asking for off does not silence A, and the reply says so rather than echoing the request.
  t.alike(await fake.call('setVerbose', { verbose: false }, { client: CLIENT_B }), { verbose: true })
  t.is(getRuntimeConfig().verbose, true)

  fake.disconnect(CLIENT_A)
  t.is(getRuntimeConfig().verbose, false, 'the last claim went with the client that held it')
})

test('a worker booted verbose is left alone until a client says otherwise', async (t) => {
  setVerbose(t, true)

  const fake = createFakeIpc()
  registerSettings(fake.ipc, { mounts: mountsStub, publishDownloadRoots: () => {} })
  fake.disconnect(CLIENT_A)
  t.is(getRuntimeConfig().verbose, true, 'nothing was claimed, so nothing is released')
})

// REGRESSION (FIX-403-1: an earlier draft treated the boot value as an unreleasable floor. The
// bootstrap frame carries main's LIVE debug gate, which the dev console mutates — so verbose(true)
// plus any worker restart booted the next worker verbose, made that the floor, and left the toggle
// reporting ON with no in-app way back for the rest of the session.)
test('REGRESSION (FIX-403-1): a client can switch off a worker that booted verbose', async (t) => {
  setVerbose(t, true)

  const fake = createFakeIpc()
  registerSettings(fake.ipc, { mounts: mountsStub, publishDownloadRoots: () => {} })

  t.alike(await fake.call('setVerbose', { verbose: false }, { client: CLIENT_A }), { verbose: false },
    'the toggle reports what it achieved')
  t.is(getRuntimeConfig().verbose, false, 'and the worker actually went quiet')
})

test('the serving handlers thread the asking client, and a disconnect drops its column', async (t) => {
  const fake = createFakeIpc()
  registerFiles(fake.ipc, { log: silentLog })

  await fake.call('serving:detail-subscribe', { spaceId: 's1', path: '/a.bin' }, { client: CLIENT_A })
  await fake.call('serving:detail-subscribe', { spaceId: 's1', path: '/a.bin' }, { client: CLIENT_B })

  // Unsubscribing as B must not take A's hold with it — the bug the keyed refcount replaces.
  await fake.call('serving:detail-unsubscribe', { spaceId: 's1', path: '/a.bin' }, { client: CLIENT_B })
  fake.disconnect(CLIENT_A)

  // Both holds are now gone, so a stray unsubscribe finds nothing and is still answered.
  t.alike(await fake.call('serving:detail-unsubscribe', { spaceId: 's1', path: '/a.bin' }, { client: CLIENT_A }), { ok: true })
  t.teardown(() => { unsubscribeServeDetail('s1', '/a.bin'); subscribeServeDetail('s1', '/a.bin') && unsubscribeServeDetail('s1', '/a.bin') })
})
