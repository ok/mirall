import test from 'brittle'
import fs from 'bare-fs'
import crypto from 'hypercore-crypto'
import { openStore, setMasterSecret } from '../../src/shared/core/store.js'
import { initAuditLog, flushAudit, setAuditConfig } from '../../src/shared/audit/audit-log.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'
import { purgeAudit } from '../../src/shared/audit/audit-reclaim.js'
import { initNetworkWatch, resetNetworkWatch, peerRelayed, peerUnrelayed } from '../../src/shared/audit/network-watch.js'
import { createTimers } from '../../src/shared/core/timers.js'
import { tmpDir } from '../helpers/bare-tmp.js'

let watchTimers = null

const DWELL = 60
const PROFILE_KEY = 'ab'.repeat(32)
const RELAY_KEY = 'yry4bqaudkr5bn9wf7pjfka1rf6m6r7yb9c4e7t5j8njbke6xk7q'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const settle = () => sleep(DWELL * 4)

async function boot(t) {
  const storage = tmpDir('netwatch-relay-store')
  t.teardown(() => {
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

async function rows() {
  await flushAudit()
  const { entries } = await queryAudit({ limit: 200 })
  return entries.filter((e) => e.kind === 'network.peer_relayed')
}

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
  t.is(written[0].subject.relay, RELAY_KEY)
  t.is(written[0].subject.label, null)
  t.is(written[0].subject.plane, 'control')
})

test('a connection that goes direct within the dwell writes nothing', async (t) => {
  await boot(t)
  const socket = {}
  peerRelayed(socket, adopted)
  peerUnrelayed(socket)
  await settle()
  t.is((await rows()).length, 0)
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

test('one row per member and relay per session', async (t) => {
  await boot(t)
  peerRelayed({}, adopted)
  await settle()
  peerRelayed({}, adopted)
  await settle()
  t.is((await rows()).length, 1)
  peerRelayed({}, () => ({ ...adopted(), relayKey: 'ic3dnb1x4n6eq5c1ymfju9sm3yny53to7dwzdg7ejt8mbrwc1jso' }))
  await settle()
  t.is((await rows()).length, 2, 'a different relay is a new fact')
  peerRelayed({}, () => ({ ...adopted(), plane: 'content' }))
  await settle()
  t.is((await rows()).length, 3, 'the other plane is a new fact')
})

test('a connection that stopped being relayed by the dwell writes nothing', async (t) => {
  await boot(t)
  peerRelayed({}, () => null)
  await settle()
  t.is((await rows()).length, 0)
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
  t.is((await rows()).length, 0)
})
