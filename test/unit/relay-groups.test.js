import test from 'brittle'
import { relayGroups, relayState, peopleLabel, relayKindClasses, relayedPeopleCount, peersRelayingWhileOff, MAX_NAMES_SHOWN } from '../../src/renderer/model/relay-groups.js'

const R1 = 'r1'.repeat(26)
const R2 = 'r2'.repeat(26)
const conn = (over = {}) => ({ noiseKey: 'aa'.repeat(32), personKey: 'a1'.repeat(32), plane: 'control', displayName: 'Anna', via: 'own', relayKey: R1, since: 10, ...over })
const t = (key, values = {}) => `${key}:${JSON.stringify(values)}`

test('the configured relay is one group carrying everyone it relays, sorted first', (t2) => {
  const groups = relayGroups([
    conn({ noiseKey: 'bb'.repeat(32), personKey: 'b1'.repeat(32), displayName: 'Bob', via: 'adopted', relayKey: R2 }),
    conn({ noiseKey: 'aa'.repeat(32), displayName: 'Anna' }),
    conn({ noiseKey: 'cc'.repeat(32), personKey: 'c1'.repeat(32), displayName: 'Carla' }),
  ])
  t2.is(groups.length, 2)
  t2.is(groups[0].via, 'own')
  t2.is(groups[0].relayKey, R1)
  t2.is(groups[0].providerName, null)
  t2.alike(groups[0].people.map((p) => p.displayName), ['Anna', 'Carla'])
})

test('an adopted relay is one group per peer, credited to that peer', (t2) => {
  const groups = relayGroups([
    conn({ noiseKey: 'aa'.repeat(32), displayName: 'Anna', via: 'adopted', relayKey: R2 }),
    conn({ noiseKey: 'bb'.repeat(32), personKey: 'b1'.repeat(32), displayName: 'Bob', via: 'adopted', relayKey: R2 }),
    conn({ noiseKey: 'cc'.repeat(32), personKey: null, displayName: null, via: 'adopted', relayKey: R2 }),
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
  const people = (n) => Array.from({ length: n }, (_, i) => ({ noiseKey: `${i}`.repeat(64), displayName: `P${i}`, since: 0, planes: ['control'] }))
  const c = 'networkStatus.relayed.plane.control:{}'
  t2.is(peopleLabel(people(2), t), `P0 (${c}) · P1 (${c})`)
  t2.is(peopleLabel(people(MAX_NAMES_SHOWN), t).split(' · ').length, 5)
  t2.ok(peopleLabel(people(7), t).startsWith('networkStatus.relayed.moreNames:'))
  t2.is(peopleLabel([{ noiseKey: 'ab'.repeat(32), displayName: null, since: 0, planes: ['content'] }], t), `abababababab (networkStatus.relayed.plane.content:{})`)
  t2.is(peopleLabel([{ noiseKey: 'ab'.repeat(32), displayName: 'Lena', since: 0, planes: ['control', 'content'] }], t), 'Lena (networkStatus.relayed.plane.both:{})')
})

test('relayKindClasses is the one source for the two kind tones', (t2) => {
  t2.is(relayKindClasses('open'), 'bg-info text-on-info')
  t2.is(relayKindClasses('private'), 'bg-secondary-container text-on-secondary-container')
})

test('both planes of one person fold into one entry with the earliest since, across different socket keys', (t2) => {
  const groups = relayGroups([
    conn({ noiseKey: 'a2'.repeat(32), plane: 'content', since: 20 }),
    conn({ noiseKey: 'a3'.repeat(32), plane: 'control', since: 10 }),
    conn({ noiseKey: 'bb'.repeat(32), personKey: 'b1'.repeat(32), displayName: 'Bob', plane: 'content', via: 'adopted', relayKey: R2, since: 5 }),
  ])
  t2.is(groups[0].people.length, 1)
  t2.alike(groups[0].people[0].planes, ['content', 'control'])
  t2.is(groups[0].people[0].since, 10)
  t2.alike(groups[1].people[0].planes, ['content'])
})

test('relayedPeopleCount counts people, not sockets', (t2) => {
  const relay = { connections: [conn({ noiseKey: 'a2'.repeat(32), plane: 'control' }), conn({ noiseKey: 'a3'.repeat(32), plane: 'content' }), conn({ noiseKey: 'bb'.repeat(32), personKey: 'b1'.repeat(32) })], direct: { control: 0, content: 0 }, digest: '' }
  t2.is(relayedPeopleCount(relay), 2)
})

test('an adopted relay from one person on two sockets is one group', (t2) => {
  const groups = relayGroups([
    conn({ noiseKey: 'a2'.repeat(32), plane: 'content', via: 'adopted', relayKey: R2, displayName: 'Oliver' }),
    conn({ noiseKey: 'a3'.repeat(32), plane: 'control', via: 'adopted', relayKey: R2, displayName: 'Oliver' }),
  ])
  t2.is(groups.length, 1)
  t2.is(groups[0].providerName, 'Oliver')
  t2.alike(groups[0].people[0].planes, ['content', 'control'])
})

test('a socket with no bound member yet stays its own person', (t2) => {
  const groups = relayGroups([
    conn({ noiseKey: 'a2'.repeat(32), personKey: null, displayName: null, via: 'adopted', relayKey: R2 }),
    conn({ noiseKey: 'a3'.repeat(32), personKey: null, displayName: null, via: 'adopted', relayKey: R2 }),
  ])
  t2.is(groups.length, 2)
  t2.is(groups[0].people[0].foldKey, 'a2'.repeat(32), 'it folds under its own socket key, not a person it has not got')
})

// The fold key is the person once one is bound and the socket until then, so the two are separate
// fields: the row's socket key never stands in for the identity anywhere but the fold.
test('a bound socket folds by its person while still naming its socket', (t2) => {
  const [group] = relayGroups([conn({ noiseKey: 'a2'.repeat(32), personKey: 'b1'.repeat(32) })])
  t2.is(group.people[0].foldKey, 'b1'.repeat(32))
  t2.is(group.people[0].noiseKey, 'a2'.repeat(32))
})

test('peersRelayingWhileOff names each member whose own relay carries us, once, and only while off', (t2) => {
  const status = { connections: [
    conn({ noiseKey: 'bb'.repeat(32), personKey: 'b1'.repeat(32), displayName: 'Bob', via: 'adopted', relayKey: R2 }),
    conn({ noiseKey: 'bc'.repeat(32), personKey: 'b1'.repeat(32), displayName: 'Bob', via: 'adopted', relayKey: R2, plane: 'content' }),
    conn({ noiseKey: 'cc'.repeat(32), personKey: 'c1'.repeat(32), displayName: 'Carla', via: 'adopted', relayKey: R2 }),
    conn({ noiseKey: 'aa'.repeat(32), displayName: 'Anna' }),
  ], direct: { control: 0, content: 0 }, seen: 4, digest: 'd' }
  const people = peersRelayingWhileOff('off', status)
  t2.alike(people.map((p) => p.displayName), ['Bob', 'Carla'])
  t2.alike(people[0].planes, ['control', 'content'], 'both planes fold into one person')
  t2.alike(peersRelayingWhileOff('auto', status), [], 'an adopted relay under auto is the feature working')
  t2.alike(peersRelayingWhileOff('always', status), [])
  t2.alike(peersRelayingWhileOff('off', null), [])
  t2.alike(peersRelayingWhileOff('off', { ...status, connections: [conn({})] }), [], 'our own relay is not named')
})

test('peersRelayingWhileOff names a member once when their sockets paired on different relay keys', (t2) => {
  const status = { connections: [
    conn({ noiseKey: 'bb'.repeat(32), personKey: 'b1'.repeat(32), displayName: 'Bob', via: 'adopted', relayKey: R1, since: 20 }),
    conn({ noiseKey: 'bc'.repeat(32), personKey: 'b1'.repeat(32), displayName: 'Bob', via: 'adopted', relayKey: R2, plane: 'content', since: 5 }),
  ], direct: { control: 0, content: 0 }, seen: 2, digest: 'd' }
  const people = peersRelayingWhileOff('off', status)
  t2.is(people.length, 1)
  t2.alike(people[0].planes, ['control', 'content'])
  t2.is(people[0].since, 5)
})
