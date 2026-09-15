import test from 'brittle'
import {
  initLinkLiveness, resetLinkLiveness, checkLivenessNow, linkSnapshot, clearLinkFailures, startLinkLiveness,
} from '../../src/shared/network/link-liveness.js'

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const physical = { en0: [{ address: '192.168.1.2', internal: false, family: 'IPv4' }] }
const nothing = { lo0: [{ address: '127.0.0.1', internal: true, family: 'IPv4' }] }

function link(t, { ping, connections = 0, interfaces = physical } = {}) {
  const changes = []
  const dht = {
    toArray: () => [{ host: '1.2.3.4', port: 1 }],
    ping: ping || (() => Promise.resolve()),
  }
  const swarm = { dht, suspended: false, destroyed: false, connections: { size: connections } }
  const env = { interfaces }
  initLinkLiveness({
    log: silentLog,
    getSwarm: () => swarm,
    isDhtReady: () => true,
    readInterfaces: () => env.interfaces,
    onChange: () => changes.push(linkSnapshot()),
  })
  t.teardown(() => resetLinkLiveness())
  return { changes, env, swarm }
}

test('a failing ping counts up to the offline threshold and no further', async (t) => {
  const { changes } = link(t, { ping: () => Promise.reject(new Error('unreachable')) })
  t.is((await checkLivenessNow()).failures, 1)
  t.is((await checkLivenessNow()).failures, 2)
  t.is((await checkLivenessNow()).failures, 2, 'capped at LIVENESS_FAILURES_FOR_OFFLINE')
  t.is(changes.length, 2, 'the owner hears each change, not the capped repeat')
})

test('a first failure is confirmed by a prompt retry, not the next interval', async (t) => {
  let pings = 0
  link(t, { ping: () => { pings++; return Promise.reject(new Error('unreachable')) } })
  await checkLivenessNow()
  t.is(pings, 1)
  await delay(2100)
  t.is(pings, 2, 'the retry fired on its own')
  t.is(linkSnapshot().failures, 2)
})

test('a successful ping resets the count', async (t) => {
  let ok = false
  link(t, { ping: () => (ok ? Promise.resolve() : Promise.reject(new Error('unreachable'))) })
  await checkLivenessNow()
  ok = true
  t.is((await checkLivenessNow()).failures, 0)
})

test('no ping while a connected peer vouches for the link', async (t) => {
  let pings = 0
  link(t, { ping: () => { pings++; return Promise.resolve() }, connections: 1 })
  await checkLivenessNow()
  t.is(pings, 0)
})

test('a ping that throws synchronously is a failure, not a crash', async (t) => {
  link(t, { ping: () => { throw new Error('not a valid IP address') } })
  t.is((await checkLivenessNow()).failures, 1)
})

test('a route reappearing restarts the failure count', async (t) => {
  const { changes, env } = link(t, { ping: () => Promise.reject(new Error('unreachable')), interfaces: nothing })
  startLinkLiveness()
  t.is(linkSnapshot().interfaceKind, 'none')
  await checkLivenessNow()
  t.is(linkSnapshot().failures, 1)
  env.interfaces = physical
  await delay(3100)
  t.is(linkSnapshot().interfaceKind, 'physical', 'the poll saw the route come back')
  t.is(linkSnapshot().failures, 0)
  t.ok(changes.some((c) => c.interfaceKind === 'physical'), 'and the owner was told')
})

test('a connection clears the failures without a ping', async (t) => {
  link(t, { ping: () => Promise.reject(new Error('unreachable')) })
  await checkLivenessNow()
  clearLinkFailures()
  t.is(linkSnapshot().failures, 0)
})
