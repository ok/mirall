import test from 'brittle'
import { relayGroups, relayState, peopleLabel, relayKindClasses, relayedPeopleCount, MAX_NAMES_SHOWN } from '../../src/renderer/model/relay-groups.js'

const R1 = 'r1'.repeat(26)
const R2 = 'r2'.repeat(26)
const conn = (over = {}) => ({ peerKey: 'aa'.repeat(32), plane: 'control', displayName: 'Anna', via: 'own', relayKey: R1, since: 10, ...over })
const t = (key, values = {}) => `${key}:${JSON.stringify(values)}`

test('the configured relay is one group carrying everyone it relays, sorted first', (t2) => {
  const groups = relayGroups([
    conn({ peerKey: 'bb'.repeat(32), displayName: 'Bob', via: 'adopted', relayKey: R2 }),
    conn({ peerKey: 'aa'.repeat(32), displayName: 'Anna' }),
    conn({ peerKey: 'cc'.repeat(32), displayName: 'Carla' }),
  ])
  t2.is(groups.length, 2)
  t2.is(groups[0].via, 'own')
  t2.is(groups[0].relayKey, R1)
  t2.is(groups[0].providerName, null)
  t2.alike(groups[0].people.map((p) => p.displayName), ['Anna', 'Carla'])
})

test('an adopted relay is one group per peer, credited to that peer', (t2) => {
  const groups = relayGroups([
    conn({ peerKey: 'aa'.repeat(32), displayName: 'Anna', via: 'adopted', relayKey: R2 }),
    conn({ peerKey: 'bb'.repeat(32), displayName: 'Bob', via: 'adopted', relayKey: R2 }),
    conn({ peerKey: 'cc'.repeat(32), displayName: null, via: 'adopted', relayKey: R2 }),
  ])
  t2.is(groups.length, 3)
  t2.alike(groups.map((g) => g.providerName), ['Anna', 'Bob', null])
  t2.ok(groups.every((g) => g.relayKey === R2 && g.people.length === 1))
  t2.is(new Set(groups.map((g) => g.key)).size, 3)
})

test('relayState reads off only when nothing is relayed and the mode is off', (t2) => {
  const none = { connections: [], direct: { control: 2, content: 2 }, digest: '' }
  const used = { connections: [conn({ via: 'adopted' })], direct: { control: 0, content: 0 }, digest: 'x' }
  t2.is(relayState('off', none), 'off')
  t2.is(relayState('auto', none), 'none')
  t2.is(relayState('always', none), 'none')
  t2.is(relayState('off', used), 'used')
  t2.is(relayState('auto', used), 'used')
})

test('peopleLabel joins names, caps at five, and falls back to a short key', (t2) => {
  const people = (n) => Array.from({ length: n }, (_, i) => ({ peerKey: `${i}`.repeat(64), displayName: `P${i}`, since: 0, planes: ['control'] }))
  const c = 'networkStatus.relayed.plane.control:{}'
  t2.is(peopleLabel(people(2), t), `P0 (${c}) · P1 (${c})`)
  t2.is(peopleLabel(people(MAX_NAMES_SHOWN), t).split(' · ').length, 5)
  t2.ok(peopleLabel(people(7), t).startsWith('networkStatus.relayed.moreNames:'))
  t2.is(peopleLabel([{ peerKey: 'ab'.repeat(32), displayName: null, since: 0, planes: ['content'] }], t), `abababababab (networkStatus.relayed.plane.content:{})`)
  t2.is(peopleLabel([{ peerKey: 'ab'.repeat(32), displayName: 'Lena', since: 0, planes: ['control', 'content'] }], t), 'Lena (networkStatus.relayed.plane.both:{})')
})

test('relayKindClasses is the one source for the two kind tones', (t2) => {
  t2.is(relayKindClasses('open'), 'bg-info text-on-info')
  t2.is(relayKindClasses('private'), 'bg-secondary-container text-on-secondary-container')
})

test('both planes of one person fold into one entry with the earliest since', (t2) => {
  const groups = relayGroups([
    conn({ plane: 'content', since: 20 }),
    conn({ plane: 'control', since: 10 }),
    conn({ peerKey: 'bb'.repeat(32), displayName: 'Bob', plane: 'content', via: 'adopted', relayKey: R2, since: 5 }),
  ])
  t2.is(groups[0].people.length, 1)
  t2.alike(groups[0].people[0].planes, ['content', 'control'])
  t2.is(groups[0].people[0].since, 10)
  t2.alike(groups[1].people[0].planes, ['content'])
})

test('relayedPeopleCount counts people, not sockets', (t2) => {
  const relay = { connections: [conn({ plane: 'control' }), conn({ plane: 'content' }), conn({ peerKey: 'bb'.repeat(32) })], direct: { control: 0, content: 0 }, digest: '' }
  t2.is(relayedPeopleCount(relay), 2)
})
