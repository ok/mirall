import test from 'brittle'
import { memberPresence, PRESENCE_LABEL, MEMBER_PRESENCE } from '../../src/renderer/model/member-presence.js'

test('offline wins regardless of reach', (t) => {
  t.is(memberPresence({ online: false, reach: 'relayed' }), 'offline')
  t.is(memberPresence({ online: false, reach: 'direct' }), 'offline')
  t.is(memberPresence({ online: false, reach: null }), 'offline')
})

test('an online member reads online unless a relay carries them', (t) => {
  t.is(memberPresence({ online: true, reach: null }), 'online')
  t.is(memberPresence({ online: true, reach: 'direct' }), 'online')
  t.is(memberPresence({ online: true, reach: 'relayed' }), 'relayed')
  t.is(memberPresence({}), 'online', 'an absent online flag still reads online')
})

test('every presence has exactly one static label key', (t) => {
  const presences = Object.values(MEMBER_PRESENCE)
  t.is(presences.length, 3)
  const keys = presences.map((p) => PRESENCE_LABEL[p])
  t.is(new Set(keys).size, 3, 'no two states share a string')
  for (const k of keys) t.ok(k.startsWith('member.'), k)
})
