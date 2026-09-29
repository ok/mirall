import test from 'brittle'
import fs from 'bare-fs'
import crypto from 'hypercore-crypto'
import { openStore, setMasterSecret } from '../../src/shared/core/store.js'
import { initAuditLog, flushAudit, setAuditConfig } from '../../src/shared/audit/audit-log.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'
import { purgeAudit } from '../../src/shared/audit/audit-reclaim.js'
import {
  initNetworkWatch, resetNetworkWatch, peerRelayed, peerUnrelayed, peerSeen, setRelayReach,
} from '../../src/shared/audit/network-watch.js'
import { truncateRelayKey } from '../../src/shared/contract/relay-key.js'
import { createTimers } from '../../src/shared/core/timers.js'
import { tmpDir } from '../helpers/bare-tmp.js'

let watchTimers = null
// How the person reads when the log checks their path; each test sets it before the edge.
let reach = null

const DWELL = 60
const PROFILE_KEY = 'ab'.repeat(32)
const RELAY_KEY = 'yry4bqaudkr5bn9wf7pjfka1rf6m6r7yb9c4e7t5j8njbke6xk7q'
const OTHER_RELAY_KEY = 'ic3dnb1x4n6eq5c1ymfju9sm3yny53to7dwzdg7ejt8mbrwc1jso'
const RELAYED = 'network.peer_relayed'
const DIRECT = 'network.peer_direct'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = () => sleep(DWELL * 4)

async function boot(t) {
  const storage = tmpDir('netwatch-relay-store')
  reach = 'relayed'
  setRelayReach(() => reach)
  t.teardown(() => {
    setRelayReach(null)
    resetNetworkWatch()
    watchTimers?.close()
    watchTimers = null
    try { fs.rmSync(storage, { recursive: true, force: true }) } catch {}
  })
  await openStore(storage)
  setMasterSecret(crypto.randomBytes(32))
  await initAuditLog({ installId: 'install-under-test' })
  await setAuditConfig({ enabled: true, retentionDays: 90, maxEntries: 200000 })
  await purgeAudit()
  watchTimers = createTimers()
  initNetworkWatch({ sessionId: 'run-1', dwellMs: DWELL, peerDwellMs: DWELL, relayDwellMs: DWELL, timers: watchTimers })
}

// Oldest first, both path kinds.
async function pathRows() {
  await flushAudit()
  const { entries } = await queryAudit({ limit: 200 })
  return entries.filter((e) => e.kind === RELAYED || e.kind === DIRECT).reverse()
}

const kindsOf = async () => (await pathRows()).map((e) => e.kind)
const rows = async () => (await pathRows()).filter((e) => e.kind === RELAYED)

const adopted = () => ({ noiseKey: 'cd'.repeat(32), plane: 'control', personKey: PROFILE_KEY, displayName: 'Lena', via: 'adopted', relayKey: RELAY_KEY, since: 1, relayLabel: null })
const own = () => ({ ...adopted(), via: 'own', relayLabel: 'Hetzner box' })
const ownUnlabelled = () => ({ ...adopted(), via: 'own', relayLabel: '' })

test('a relayed connection that outlives the dwell writes one row naming the provenance', async (t) => {
  await boot(t)
  const socket = {}
  peerRelayed(socket, adopted)
  t.is((await rows()).length, 0, 'nothing before the dwell')
  await settle()
  const written = await rows()
  t.is(written.length, 1)
  t.is(written[0].actor.name, 'Lena')
  t.is(written[0].actor.key, PROFILE_KEY)
  t.is(written[0].subject.via, 'adopted')
  t.is(written[0].subject.provider, 'Lena')
  t.is(written[0].subject.relay, truncateRelayKey(RELAY_KEY), 'the relay key is stored masked')
  t.absent(JSON.stringify(written[0]).includes(RELAY_KEY), 'and the full key appears nowhere in the row')
  t.is(written[0].subject.label, null)
  t.is(written[0].subject.plane, 'control')
})

test('a connection that goes direct within the dwell writes nothing', async (t) => {
  await boot(t)
  const socket = {}
  peerRelayed(socket, adopted)
  reach = 'direct'
  peerUnrelayed(socket, PROFILE_KEY)
  await settle()
  t.alike(await kindsOf(), [])
})

test('a socket with no handshake by the dwell re-arms and writes once the member is bound', async (t) => {
  await boot(t)
  let bound = false
  peerRelayed({}, () => (bound ? adopted() : { ...adopted(), personKey: null, displayName: null }))
  await settle()
  t.is((await rows()).length, 0, 'nothing while unbound')
  bound = true
  await settle()
  t.is((await rows()).length, 1, 'written on a later dwell')
})

test('one row per person per relayed stretch, whatever plane or relay carries it', async (t) => {
  await boot(t)
  peerRelayed({}, adopted)
  await settle()
  peerRelayed({}, adopted)
  peerRelayed({}, () => ({ ...adopted(), relayKey: OTHER_RELAY_KEY }))
  peerRelayed({}, () => ({ ...adopted(), plane: 'content' }))
  await settle()
  t.alike(await kindsOf(), [RELAYED], 'every socket joined the stretch the first one opened')
})

test('a relayed stretch that ends direct writes one direct row after the dwell', async (t) => {
  await boot(t)
  const socket = {}
  peerRelayed(socket, adopted)
  await settle()
  reach = 'direct'
  peerUnrelayed(socket, PROFILE_KEY)
  t.alike(await kindsOf(), [RELAYED], 'not before the closing dwell')
  await settle()
  const direct = (await pathRows()).filter((e) => e.kind === DIRECT)
  t.is(direct.length, 1)
  t.is(direct[0].actor.key, PROFILE_KEY)
  t.is(direct[0].actor.name, 'Lena')
  t.is(direct[0].target.id, PROFILE_KEY)
  t.ok(direct[0].subject.relayedMs >= 0, 'how long the relay carried them')
  t.absent('durationMs' in direct[0].subject, 'never rendered as an offline duration')
})

test('a disconnect writes nothing, and a direct return closes the stretch', async (t) => {
  await boot(t)
  const socket = {}
  peerRelayed(socket, adopted)
  await settle()
  reach = null
  peerUnrelayed(socket, PROFILE_KEY)
  await settle()
  t.alike(await kindsOf(), [RELAYED], 'nothing while the person is away')
  reach = 'direct'
  peerSeen(PROFILE_KEY, 'space-1')
  await settle()
  t.alike(await kindsOf(), [RELAYED, DIRECT], 'the log agrees with the roster once they are back')
})

test('an unrelay edge that cannot name its person still closes the stretch', async (t) => {
  await boot(t)
  const socket = {}
  peerRelayed(socket, adopted)
  await settle()
  reach = 'direct'
  peerUnrelayed(socket, null)
  await settle()
  t.alike(await kindsOf(), [RELAYED, DIRECT])
})

test('rejoining a relay inside the closing dwell continues the stretch', async (t) => {
  await boot(t)
  const first = {}
  peerRelayed(first, adopted)
  await settle()
  const second = {}
  peerRelayed(second, adopted)
  peerUnrelayed(first, PROFILE_KEY)
  await settle()
  t.alike(await kindsOf(), [RELAYED], 'the re-dialled socket joined; nothing closed')
  reach = 'direct'
  peerUnrelayed(second, PROFILE_KEY)
  await settle()
  t.alike(await kindsOf(), [RELAYED, DIRECT], 'the stretch ends once, when its last socket leaves')
})

test('a relayed row the log refused never gets a lone direct row', async (t) => {
  await boot(t)
  const socket = {}
  await setAuditConfig({ enabled: false, retentionDays: 90, maxEntries: 200000 })
  peerRelayed(socket, adopted)
  await settle()
  await setAuditConfig({ enabled: true, retentionDays: 90, maxEntries: 200000 })
  reach = 'direct'
  peerUnrelayed(socket, PROFILE_KEY)
  await settle()
  t.alike(await kindsOf(), [])
})

test('relayed, direct, relayed again writes one row per stretch', async (t) => {
  await boot(t)
  const first = {}
  peerRelayed(first, adopted)
  await settle()
  reach = 'direct'
  peerUnrelayed(first, PROFILE_KEY)
  await settle()
  peerRelayed({}, adopted)
  await settle()
  t.alike(await kindsOf(), [RELAYED, DIRECT, RELAYED])
})

test('a connection that stopped being relayed by the dwell writes nothing', async (t) => {
  await boot(t)
  peerRelayed({}, () => null)
  await settle()
  t.alike(await kindsOf(), [])
})

test('own relay rows carry the configured label and no provider', async (t) => {
  await boot(t)
  peerRelayed({}, own)
  await settle()
  const written = await rows()
  t.is(written.length, 1)
  t.is(written[0].subject.via, 'own')
  t.is(written[0].subject.label, 'Hetzner box')
  t.is(written[0].subject.provider, null)
})

test('an empty own label is stored as null', async (t) => {
  await boot(t)
  peerRelayed({}, ownUnlabelled)
  await settle()
  t.is((await rows())[0].subject.label, null)
})

test('reset cancels a pending dwell', async (t) => {
  await boot(t)
  peerRelayed({}, adopted)
  resetNetworkWatch()
  await settle()
  t.alike(await kindsOf(), [])
})

test('reset cancels a pending closing dwell', async (t) => {
  await boot(t)
  const socket = {}
  peerRelayed(socket, adopted)
  await settle()
  reach = 'direct'
  peerUnrelayed(socket, PROFILE_KEY)
  resetNetworkWatch()
  await settle()
  t.alike(await kindsOf(), [RELAYED])
})
