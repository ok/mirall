import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const src = (rel) => readFileSync(path.join(root, 'src', rel), 'utf8')

// Vendored overlay code spells a hypercore feed key `peerKey`; it stays re-diffable against
// upstream, so it is exempt rather than renamed.
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'vendor' && name !== 'locales') walk(p, out) }
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

function offenders(pattern, files) {
  return files.filter((f) => pattern.test(readFileSync(f, 'utf8'))).map((f) => path.relative(root, f)).sort()
}

// `peerKey` named three different things at once: one socket's Noise key, a member identity, and a
// composite map key. Each has its own word now — noiseKey, personKey, episodeKey — so the collided
// one may not come back.
test('nothing is called peerKey', (t) => {
  const files = walk(path.join(root, 'src'))
  t.ok(files.length > 300, `walked ${files.length} modules`)
  t.alike(offenders(/\bpeerKeys?\b/, files), [], 'modules still naming something peerKey')
})

// A transport key is not an identity: a person's control and content sockets carry different Noise
// keys, so anything that folds by person reads personKey and anything that names a socket reads
// noiseKey. The relay snapshot is where both meet.
test('the relay snapshot names the socket and the person apart', (t) => {
  const snapshot = src('shared/network/relayed-connections.js')
  t.ok(/noiseKey: b4a\.toString\(socket\.remotePublicKey, 'hex'\)/.test(snapshot), 'the socket key is a noiseKey')
  t.ok(/personKey: member\?\.profileKey \?\? null/.test(snapshot), 'the member identity is a personKey')
})

// The contract is what a second client generates its types from, so the two questions have to be
// askable there rather than resolved by whoever happens to read the payload.
test('the contract names person, device and org', (t) => {
  const principals = src('shared/contract/principals.js')
  for (const name of ['PersonKey', 'DeviceKey', 'OrgKey', 'NoiseKey', 'PrincipalRef']) {
    t.ok(new RegExp(`@typedef \\{.+\\} ${name}\\b`).test(principals), `${name} is declared`)
  }
  t.ok(/personKey: PersonKey, deviceKey: DeviceKey, orgKey: OrgKey \| null/.test(principals),
    'a principal carries all three, and the org one is nullable')

  const responses = src('shared/contract/responses.ts')
  t.ok(/export interface Profile extends PrincipalRef/.test(responses), 'the profile answers all three')
  t.ok(/publicKey: PersonKey/.test(responses), 'a roster key is typed as the person it names')
})

// The equality between the three keys is the grandfathering rule, and it is written down once so
// there is one site to change when a device roster exists.
test('only the contract asserts that a person and a device are the same key', (t) => {
  const files = walk(path.join(root, 'src')).filter((f) => !f.endsWith(path.join('contract', 'principals.js')))
  t.alike(offenders(/deviceKey:\s*[a-zA-Z]/, files), [], 'modules building a principal by hand')
})
