import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (...parts) => readFileSync(path.join(here, '..', '..', ...parts), 'utf8')

// The roster's reach badge re-derives on a poke, and the two edges that change a member's reach are
// wired in composition roots no suite boots: the relay→direct upgrade in the control swarm's
// collaborator wiring, and the content-hello bind in boot's content swarm. Each is one property of
// one options object, and each consumer defaults it away when it is missing — so dropping either
// leaves every other suite green while the badge on screen stops following the network.
test('the control swarm wires the relay upgrade to the members poke', (t) => {
  const swarm = read('src', 'shared', 'network', 'swarm.js')
  t.ok(/initRelayInstall\(\{[^}]*\bonReachChange: pokeMemberSpaces\b/.test(swarm),
    'initRelayInstall is handed the poke as onReachChange')
  t.ok(/^import \{[^}]*\bpokeMemberSpaces\b[^}]*\} from '\.\/handshake-apply\.js'$/m.test(swarm),
    'and takes it from handshake-apply, which owns the members coalescer')

  const install = read('src', 'shared', 'network', 'relay-install.js')
  t.ok(/onReachChange = deps\.onReachChange/.test(install), 'relay-install reads the dep off its deps')
  t.ok(/onUnrelayed: \(socket, member\) => \{[^}]*onReachChange\(member\)/.test(install),
    'and calls it on the unrelay edge, with the member whose rows changed')
})

test('boot wires the content-hello bind to the members poke', (t) => {
  const boot = read('src', 'worker', 'boot.js')
  t.ok(/new ContentSwarm\('content-swarm', \{[^}]*\bonPeerBound: pokeMemberSpacesByKey\b/.test(boot),
    'the content swarm is handed the poke as onPeerBound')
  t.ok(/^import \{ pokeMemberSpacesByKey \} from '\.\.\/shared\/network\/handshake-apply\.js'$/m.test(boot),
    'and takes it from handshake-apply')

  const content = read('src', 'shared', 'network', 'content-swarm.js')
  t.ok(/contentBoundHook = this\.deps\.onPeerBound/.test(content), 'the content swarm reads the dep off its deps')
  t.ok(/contentPeerSockets\.add\(socket, msg\.profileKey\)\n\s*contentBoundHook\?\.\(msg\.profileKey\)/.test(content),
    'and fires it where the socket becomes one this person is reached over')
})
