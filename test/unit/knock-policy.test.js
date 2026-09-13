import test from 'brittle'
import { knockSettledByRecords, knockInviteVerdict } from '../../src/shared/spaces/knock-policy.js'

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
