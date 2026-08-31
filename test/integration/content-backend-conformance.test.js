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

// Members a backend MAY implement. A caller must reach every one of these through `?.` and behave
// correctly when it is absent — `catalogVersion` missing means a mirror walks every tick, which is
// simply the behaviour before it existed. Kept separate from CONTRACT deliberately: promoting one of
// these to required breaks every hand-written double at once, and that is a decision to take on
// purpose rather than by adding a line to the wrong list.
const OPTIONAL = ['catalogVersion', 'init', 'attach', 'teardown', 'sweepPresence']

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

test('optional backend members are optional, and absent ones are never called unguarded', (t) => {
  setRuntimeConfig({ overlayEnabled: true })
  t.teardown(() => setRuntimeConfig({ overlayEnabled: false }))
  const backend = getContentBackend({ contentMode: 'overlay' })
  for (const name of OPTIONAL) {
    t.is(typeof backend[name], 'function', `overlay implements the optional ${name}`)
    t.absent(CONTRACT.includes(name), `${name} is NOT in the required contract`)
  }
  // The behaviour that matters — a backend missing an optional member still works — is asserted
  // against the real call site in foreign-mirror-head-skip.test.js ('a backend with no
  // catalogVersion walks every tick'). Asserting `absent?.()` here would only prove optional
  // chaining works, which is true of every JS runtime and would stay green if a caller dropped
  // the `?.`.
})
