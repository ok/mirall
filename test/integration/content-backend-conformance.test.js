import test from 'brittle'
import { getContentBackend, hasContentBackend, isUnsupportedShare, UNSUPPORTED } from '../../src/shared/transfer/content-backends.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'

// The content-backend seam contract. 'overlay' is the only backend and must
// implement every operation; every other contentMode — absent, legacy
// 'eager'/'deferred', or unknown — resolves to the UNSUPPORTED sentinel so callers
// render it unavailable and never route it to a removed path.
// listPeer is deliberately absent: it returned only the rows and dropped the read's `complete`
// flag, so a timed-out drain was indistinguishable from a real deletion (FIX-359). Every consumer
// reads through listPeerWithMeta, which carries it.
const CONTRACT = [
  'publishAdd', 'publishDelete',
  'listOwn', 'listPeerWithMeta',
  'requestDownload', 'ensureRemote', 'releaseRemote',
]

test('absent / legacy / unknown content modes are UNSUPPORTED', (t) => {
  for (const share of [{ contentMode: 'eager' }, {}, null, { contentMode: 'deferred' }, { contentMode: 'future-mode' }]) {
    t.is(getContentBackend(share), UNSUPPORTED)
    t.absent(hasContentBackend(share))
    t.ok(isUnsupportedShare(share))
  }
})

test('overlay resolves to a backend when the flag is on (UNSUPPORTED when off)', (t) => {
  t.teardown(() => setRuntimeConfig({ overlayEnabled: false }))

  setRuntimeConfig({ overlayEnabled: false })
  t.is(getContentBackend({ contentMode: 'overlay' }), UNSUPPORTED, 'flag off → unsupported, not eager, not deferred')
  t.absent(hasContentBackend({ contentMode: 'overlay' }), 'hasContentBackend false when unsupported')
  t.ok(isUnsupportedShare({ contentMode: 'overlay' }), 'isUnsupportedShare true (owner/consumer sites skip, never eager-route)')

  setRuntimeConfig({ overlayEnabled: true })
  const backend = getContentBackend({ contentMode: 'overlay' })
  t.not(backend, UNSUPPORTED, 'flag on → a real backend, not the sentinel')
  t.is(backend.mode, 'overlay')
  for (const method of CONTRACT) {
    t.is(typeof backend[method], 'function', `overlay backend implements ${method}()`)
  }
  t.ok(hasContentBackend({ contentMode: 'overlay' }), 'hasContentBackend true when usable')
  t.absent(isUnsupportedShare({ contentMode: 'overlay' }), 'isUnsupportedShare false when the flag is on')
})
