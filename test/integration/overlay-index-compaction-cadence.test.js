import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { setupOwnedShare } from '../helpers/owned.js'
import { compactIndexIfDue } from '../../src/worker/sweeps.js'

// A bare 6-hour setInterval would never fire in a normal desktop session, and the next launch
// would restart the clock — so the retired "Free up space" action would have had no replacement
// at all. The schedule is "is it due?" against a persisted timestamp, not "6h since this process
// started", which is what makes a short session still pay its pass and a long one not thrash.
test('index compaction runs when due and no-ops until the interval has passed', async (t) => {
  await freshPeer(t)
  await setupOwnedShare(t)

  t.ok(await compactIndexIfDue(), 'a store that has never compacted is due')
  t.absent(await compactIndexIfDue(), 'and is not due again straight after')
})
