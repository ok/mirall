import test from 'brittle'
import {
  claimFetch, dropFetchClaim, fetchClaimedBy, isFetchClaimed, registerFetchOwner, resetFetchClaims, FETCH_OWNER_MIRROR,
} from '../../src/shared/transfer/backends/overlay/fetch-claims.js'

function fresh (t) {
  resetFetchClaims()
  t.teardown(() => resetFetchClaims())
}

const ID = 'space1|folder1|report.pdf'

test('a second claim on the same transferId is refused', (t) => {
  fresh(t)
  t.ok(claimFetch(ID, FETCH_OWNER_MIRROR), 'the first claim is granted')
  t.is(claimFetch(ID, 'other'), null, 'the second is refused')
  t.is(fetchClaimedBy(ID), FETCH_OWNER_MIRROR, 'and the first owner still holds it')
})

test('releasing a claim frees it for the next producer', (t) => {
  fresh(t)
  const release = claimFetch(ID, FETCH_OWNER_MIRROR)
  release()
  t.absent(isFetchClaimed(ID), 'released')
  t.ok(claimFetch(ID, 'other'), 'the next producer can take it')
})

// The release is handed out before the fetch runs and called from a finally, so an out-of-order
// one is reachable: it must not free a claim that has since changed hands.
test('a stale release does not free a claim the next producer took', (t) => {
  fresh(t)
  const stale = claimFetch(ID, FETCH_OWNER_MIRROR)
  stale()
  claimFetch(ID, 'other')
  stale()
  t.is(fetchClaimedBy(ID), 'other', 'the new owner survived the stale release')
})

// An engine is a probe, not a stored claim: its own registry already has exactly the lifetime of
// its fetch, so copying it here would mean clearing it at each of start()'s bail sites.
test('a registered engine answers for its own in-flight transfers', (t) => {
  fresh(t)
  const live = new Set([ID])
  registerFetchOwner('folder', (id) => live.has(id))
  t.is(fetchClaimedBy(ID), 'folder', 'the probe reports the engine as the owner')
  t.is(claimFetch(ID, FETCH_OWNER_MIRROR), null, 'so the mirror cannot claim it')

  live.delete(ID)
  t.absent(isFetchClaimed(ID), 'the engine settled')
  t.ok(claimFetch(ID, FETCH_OWNER_MIRROR), 'and the mirror may take it on its next tick')
})

test('an unrelated transferId is never claimed by a busy one', (t) => {
  fresh(t)
  claimFetch(ID, FETCH_OWNER_MIRROR)
  t.absent(isFetchClaimed('space1|folder1|other.pdf'), 'claims are per transferId')
})

// REGRESSION: a wedged pass never reaches its finally, so a claim released only from there
// outlives the pass — and restartForeignLoop, whose whole job is to recover that mount, was then
// refused by the dead claim of the pass it had just given up on.
// The registry answers a cross-producer question. A mirror's own overlapping passes are serialised
// by activeOverlayFetches, so refusing them here would change behaviour FIX-R09-2 pins.
test('the same owner may re-enter, and its second release is inert', (t) => {
  fresh(t)
  const first = claimFetch(ID, FETCH_OWNER_MIRROR)
  const second = claimFetch(ID, FETCH_OWNER_MIRROR)
  t.ok(second, 'a second pass by the same owner is admitted')

  t.is(claimFetch(ID, 'folder'), null, 'a different owner is still refused')

  second()
  t.is(fetchClaimedBy(ID), FETCH_OWNER_MIRROR, 'the re-entrant release does not free the first holder')
  first()
  t.absent(isFetchClaimed(ID), 'the original holder still releases it')
})

test('a dropped claim frees the file for the pass that replaces it', (t) => {
  fresh(t)
  const abandoned = claimFetch(ID, FETCH_OWNER_MIRROR)
  dropFetchClaim(ID)
  const restarted = claimFetch(ID, FETCH_OWNER_MIRROR)
  t.ok(restarted, 'the restarted pass can take the file')

  // Both claims carry the same owner label, so the guard has to be the claim's own token: the
  // zombie settling later must not free the live claim.
  abandoned()
  t.is(fetchClaimedBy(ID), FETCH_OWNER_MIRROR, 'the abandoned release did not free the new claim')
  restarted()
  t.absent(isFetchClaimed(ID), 'and the live one still releases normally')
})

test('resetFetchClaims drops both claims and probes from a previous lifetime', (t) => {
  fresh(t)
  registerFetchOwner('folder', () => true)
  claimFetch(ID, FETCH_OWNER_MIRROR)

  resetFetchClaims()
  t.absent(isFetchClaimed(ID), 'a leaked claim would block one file for the life of the worker')
  t.absent(isFetchClaimed('anything'), 'and a probe closes over an engine this lifetime dropped')
})
