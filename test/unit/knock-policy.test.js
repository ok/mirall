import test from 'brittle'
import { knockSettledByRecords, knockInviteVerdict, granterVerdict, cancelVerdict, denierVerdict } from '../../src/shared/spaces/knock-policy.js'

const records = (over = {}) => ({ selfPending: false, isMember: false, hadLeft: false, isApproved: false, ...over })
const invite = (over = {}) => ({ inviteVerdict: null, hasInviteRecord: false, hadLeft: false, isDenied: false, ...over })

test('a knock we cannot answer is ignored', (t) => {
  t.is(knockSettledByRecords(records({ selfPending: true })), 'ignore',
    'holding no content key ourselves, we can neither grant nor approve')
  t.is(knockSettledByRecords(records({ selfPending: true, isMember: true })), 'ignore',
    'and that outranks every other record')
})

test('a member reconnecting is re-granted', (t) => {
  t.is(knockSettledByRecords(records({ isMember: true })), 'regrant')
})

test('an approved-but-unconfirmed joiner is re-granted', (t) => {
  t.is(knockSettledByRecords(records({ isApproved: true })), 'regrant',
    'its grant frame was undeliverable, so it re-knocks on every reconnect')
})

test('a peer we saw leave gets no shortcut', (t) => {
  t.is(knockSettledByRecords(records({ isMember: true, hadLeft: true })), null,
    'a departed member goes through fresh approval')
  t.is(knockSettledByRecords(records({ isApproved: true, hadLeft: true })), null,
    'and so does one whose approval predates the leave')
})

test('an unknown peer needs the invite resolved', (t) => {
  t.is(knockSettledByRecords(records()), null)
})

test('the invite decides what the records could not', (t) => {
  t.is(knockInviteVerdict(invite({ inviteVerdict: 'expired' })), 'deny-expired')
  t.is(knockInviteVerdict(invite({ inviteVerdict: 'auto' })), 'auto-approve')
  t.is(knockInviteVerdict(invite({ inviteVerdict: 'review' })), 'review')
  t.is(knockInviteVerdict(invite()), 'review', 'a knock with no invite raises the banner')
})

test('an expired invite outranks a denial', (t) => {
  t.is(knockInviteVerdict(invite({ inviteVerdict: 'expired', isDenied: true })), 'deny-expired')
})

test('a denial the joiner never received is replayed', (t) => {
  t.is(knockInviteVerdict(invite({ isDenied: true })), 'deny-replay',
    'the tombstone converged among members but the live frame never landed')
})

test('a valid invite re-opens a denied door', (t) => {
  t.is(knockInviteVerdict(invite({ isDenied: true, hasInviteRecord: true, inviteVerdict: 'review' })), 'review',
    'the owner re-invited them, so the banner returns rather than a silent re-deny')
})

test('a departed peer is not re-denied', (t) => {
  t.is(knockInviteVerdict(invite({ isDenied: true, hadLeft: true })), 'review',
    'leaving clears the stuck-pending state the replay exists for')
})

test('REGRESSION (MIR-26: any bound granter is honoured during the pending window)', (t) => {
  const O = 'o'.repeat(64)
  const C = 'c'.repeat(64)
  const X = 'x'.repeat(64)
  t.is(granterVerdict({ granterKey: O, inviteOwner: O, creatorKey: C }), 'accept', 'the inviter')
  t.is(granterVerdict({ granterKey: C, inviteOwner: O, creatorKey: C }), 'accept', 'the named creator')
  t.is(granterVerdict({ granterKey: X, inviteOwner: O, creatorKey: C }), 'check-fold', 'a co-member is checked against the fold')
  t.is(granterVerdict({ granterKey: X, inviteOwner: null, creatorKey: C }), 'check-fold', 'so is anyone when the invite names only the creator')
  t.is(granterVerdict({ granterKey: X, inviteOwner: O, creatorKey: null }), 'accept', 'no root, so no member set to check a co-member against')
  t.is(granterVerdict({ granterKey: X, inviteOwner: null, creatorKey: null }), 'accept', 'a bearer-only invite names nobody')
  t.is(granterVerdict({ granterKey: null, inviteOwner: O, creatorKey: C }), 'accept', 'an older granter names no key')
})

test('a knock from a key that is only an unverified seed is left to the invite', (t) => {
  t.is(knockSettledByRecords(records({ isMember: false })), null,
    'the call site reads the verified roster, so a seed knocks as a stranger')
})

test('REGRESSION (MIR-48: a cancel from anyone withdrew a pending joiner\'s request)', (t) => {
  const J = 'j'.repeat(64)
  const M = 'm'.repeat(64)
  const S = 's'.repeat(64)
  for (const enforce of [false, true]) {
    t.is(cancelVerdict({ senderKey: J, joinerKey: J, senderIsMember: false, enforce }), 'accept', 'the joiner withdraws its own request')
    t.is(cancelVerdict({ senderKey: M, joinerKey: J, senderIsMember: true, enforce }), 'accept', 'a member clears the banner after its deny')
    t.is(cancelVerdict({ senderKey: S, joinerKey: J, senderIsMember: false, enforce }), 'reject', 'a bound stranger names someone else')
  }
  t.is(cancelVerdict({ senderKey: null, joinerKey: J, senderIsMember: false, enforce: false }), 'accept-unbound', 'an older release is honoured until enforcement')
  t.is(cancelVerdict({ senderKey: null, joinerKey: J, senderIsMember: false, enforce: true }), 'reject', 'and refused once it is on')
})

test('REGRESSION (MIR-48: a deny from anyone discarded our pending request)', (t) => {
  const O = 'o'.repeat(64)
  const C = 'c'.repeat(64)
  const X = 'x'.repeat(64)
  for (const enforce of [false, true]) {
    t.is(denierVerdict({ denierKey: O, inviteOwner: O, creatorKey: C, enforce }), 'accept', 'the inviter')
    t.is(denierVerdict({ denierKey: C, inviteOwner: O, creatorKey: C, enforce }), 'accept', 'the named creator')
    t.is(denierVerdict({ denierKey: X, inviteOwner: O, creatorKey: C, enforce }), 'check-fold', 'anyone else only if the fold holds them')
    t.is(denierVerdict({ denierKey: X, inviteOwner: O, creatorKey: null, enforce }), 'reject', 'with no root there is no member set to hold them')
    t.is(denierVerdict({ denierKey: O, inviteOwner: O, creatorKey: null, enforce }), 'accept', 'but the inviter still counts')
  }
  t.is(denierVerdict({ denierKey: null, inviteOwner: O, creatorKey: C, enforce: false }), 'accept-unbound', 'an older member is honoured until enforcement')
  t.is(denierVerdict({ denierKey: null, inviteOwner: O, creatorKey: C, enforce: true }), 'reject', 'and refused once it is on')
})
