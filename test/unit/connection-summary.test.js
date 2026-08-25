import test from 'brittle'
import { fixStepsFor, reachableState, formatDuration } from '../../src/renderer/connectivity.js'

const status = (over = {}) => ({
  dhtReady: true,
  address: { publicHost: '203.0.113.7', publicPort: 41234, localPort: 41234 },
  ...over,
})

test('port 0 with a known host reads as changing ports', (t) => {
  t.is(reachableState(status({ address: { publicHost: '203.0.113.7', publicPort: 0 } })), 'changingPorts')
})

test('null host reads as noAddress, NOT changingPorts', (t) => {
  t.is(reachableState(status({ address: { publicHost: null, publicPort: 0 } })), 'noAddress')
})

test('a stable mapping reads as yes', (t) => {
  t.is(reachableState(status()), 'yes')
})

test('!dhtReady reads as unknown regardless of the address fields', (t) => {
  t.is(reachableState(status({ dhtReady: false, address: { publicHost: null, publicPort: 0 } })), 'unknown')
})

test('symmetric NAT puts the mobile step first', (t) => {
  // No router setting fixes a carrier NAT, so telling someone to check their router
  // first would send them somewhere that cannot help.
  t.alike(fixStepsFor('symmetric-nat'), ['mobile', 'vpn', 'otherNetwork'])
})

test('every other cause leads with the VPN step', (t) => {
  t.alike(fixStepsFor('peers-unreachable'), ['vpn', 'mobile', 'otherNetwork'])
  t.alike(fixStepsFor(null), ['vpn', 'mobile', 'otherNetwork'])
})

test('being offline gets network advice, not VPN and NAT advice', (t) => {
  t.alike(fixStepsFor('os-offline'), ['turnOnNetwork'])
})

test('a VPN-only route leads with the VPN step', (t) => {
  t.alike(fixStepsFor('vpn-only-route'), ['vpn', 'otherNetwork'])
})

test('formatDuration covers seconds through days', (t) => {
  t.is(formatDuration(5000), '5s')
  t.is(formatDuration(12 * 60000), '12m')
  t.is(formatDuration(3 * 3600000 + 4 * 60000), '3h 4m')
  t.is(formatDuration(50 * 3600000), '2d 2h')
  t.is(formatDuration(-1), '—')
  t.is(formatDuration(Number.NaN), '—')
})
