import test from 'brittle'
import { isServableShare } from '../../src/shared/transfer/content-mode.js'

test('an overlay share is servable', (t) => {
  t.ok(isServableShare({ contentMode: 'overlay' }))
})

// Rendered unavailable, never routed to a path this build does not have.
test('absent, legacy and unknown content modes are not', (t) => {
  for (const share of [{ contentMode: 'eager' }, { contentMode: 'deferred' }, { contentMode: 'future-mode' }, {}, null, undefined]) {
    t.absent(isServableShare(share), JSON.stringify(share))
  }
})
