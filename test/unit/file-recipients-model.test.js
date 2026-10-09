import test from 'brittle'
import { recipientSummary, recipientGroups, indexRecipients, recipientKey } from '../../src/renderer/model/file-recipients.js'

const OWNER = 'owner'
const HASH = 'current'
const member = (publicKey, extra = {}) => ({ publicKey, displayName: publicKey.toUpperCase(), online: true, ...extra })
const MEMBERS = [member(OWNER), member('ben'), member('mia'), member('jonas', { online: false }), member('lea'), member('pending', { status: 'pending' })]
const row = (personKey, ts, contentHash = HASH) => ({ shareId: 's', path: '/report.pdf', personKey, contentHash, ts })

test('a file nobody holds at its current version shows no summary', (t) => {
  t.is(recipientSummary({ recipients: [], contentHash: HASH, members: MEMBERS, ownerKey: OWNER }), null)
  t.is(recipientSummary({ recipients: [row('ben', 1, 'old')], contentHash: HASH, members: MEMBERS, ownerKey: OWNER }), null,
    'an earlier version is not the file')
})

test('holders are counted against the admitted members other than the owner, newest first', (t) => {
  const s = recipientSummary({ recipients: [row('ben', 1), row('mia', 3), row('lea', 2, 'old')], contentHash: HASH, members: MEMBERS, ownerKey: OWNER })
  t.alike(s.holders.map((m) => m.publicKey), ['mia', 'ben'])
  t.is(s.count, 2)
  t.is(s.total, 4, 'the owner and a pending joiner are not in the total')
  t.is(s.everyone, false)
})

test('a recipient who is no longer a member is not counted', (t) => {
  const s = recipientSummary({ recipients: [row('ben', 1), row('gone', 2)], contentHash: HASH, members: MEMBERS, ownerKey: OWNER })
  t.is(s.count, 1)
})

test('everyone holding it is its own state', (t) => {
  const recipients = ['ben', 'mia', 'jonas', 'lea'].map((k, i) => row(k, i))
  t.is(recipientSummary({ recipients, contentHash: HASH, members: MEMBERS, ownerKey: OWNER }).everyone, true)
})

test('groups split holders from the rest, leave live downloaders out, and list who is online first', (t) => {
  const { haveIt, notYet } = recipientGroups({
    recipients: [row('ben', 5), row('jonas', 1, 'old')],
    contentHash: HASH,
    members: MEMBERS,
    ownerKey: OWNER,
    active: new Set(['mia']),
  })
  t.alike(haveIt.map((h) => [h.member.publicKey, h.ts]), [['ben', 5]])
  t.alike(notYet.map((m) => [m.member.publicKey, m.earlier]), [['lea', false], ['jonas', true]],
    'mia is downloading, so she is in neither group; jonas is offline with an earlier version')
})

test('the index keeps the arrays of files whose recipients did not change', (t) => {
  const a = { shareId: '__loose__', path: '/a.pdf', personKey: 'ben', contentHash: HASH, ts: 1 }
  const b = { shareId: 's1', path: 'docs/b.pdf', personKey: 'mia', contentHash: HASH, ts: 2 }
  const first = indexRecipients([a, b], new Map())
  t.alike(first.get(recipientKey('/a.pdf')), [a])
  t.alike(first.get(recipientKey('docs/b.pdf', 's1')), [b], 'a folder file is keyed with its share')
  t.is(indexRecipients([{ ...a }, { ...b }], first), first, 'a refetch with nothing new is the same index')

  const c = { ...b, personKey: 'lea', ts: 3 }
  const second = indexRecipients([a, b, c], first)
  t.not(second, first)
  t.is(second.get(recipientKey('/a.pdf')), first.get(recipientKey('/a.pdf')), 'the untouched file keeps its array')
  t.alike(second.get(recipientKey('docs/b.pdf', 's1')), [b, c])
})
