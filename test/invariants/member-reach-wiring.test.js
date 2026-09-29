import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (...parts) => readFileSync(path.join(here, '..', '..', ...parts), 'utf8')

// One top-level function's source, from its signature to the closing brace at column zero.
function body(source, signature) {
  const start = source.indexOf(signature)
  if (start < 0) throw new Error(`${signature} is not in the source`)
  return source.slice(start, source.indexOf('\n}\n', start))
}

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

// The Activity Log closes a relayed stretch by reading the person's path when its dwell ends. The
// roster folds the same sockets, so both must read them from one list: a second list lets the log
// write "connected directly again" for someone the roster still shows as relayed.
test('the relay audit and the roster read one socket list per person', (t) => {
  const install = read('src', 'shared', 'network', 'relay-install.js')
  t.ok(/^import \{ reachOf \} from '\.\/member-sockets\.js'$/m.test(install), 'relay-install takes reachOf from member-sockets')
  t.ok(/\bsetRelayReach\(reachOf\)/.test(body(install, 'export function initRelayInstall(')),
    'and installs it as the audit log\'s path reader')
  t.ok(/\bsetRelayReach\(null\)/.test(body(install, 'export function resetRelayInstall(')), 'and clears it on reset')
  t.ok(/onUnrelayed: \(socket, member\) => \{[^}]*peerUnrelayed\(socket, member\?\.profileKey \?\? null\)/.test(install),
    'the unrelay edge names its person to the audit log')

  const spaces = read('src', 'worker', 'ipc', 'spaces.js')
  t.ok(/^import \{ socketsOf \} from '\.\.\/\.\.\/shared\/network\/member-sockets\.js'$/m.test(spaces),
    'members:reach takes its socket list from member-sockets')
  t.ok(/yield \[personKey, socketsOf\(personKey, peer\)\]/.test(spaces), 'and folds exactly that list')
  t.absent(/contentSocketsFor/.test(spaces), 'and builds no list of its own')
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
