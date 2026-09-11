import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import {
  connectedPeers,
  socketToPeers,
  socketMsgHandlers,
  resetRegistries,
  authorizedOn,
  peersInSpace,
  safeSend,
  broadcastToSpace,
  detachPeerFromSpace,
  forgetPeerOnSocket,
} from '../../src/shared/transfer/swarm-registries.js'

const here = path.dirname(fileURLToPath(import.meta.url))

function peer(socket, spaces, loose = []) {
  return {
    socket,
    spaces: new Map(spaces.map((s) => [s, 'drive-' + s])),
    looseCatalogKeys: new Map(loose.map((s) => [s, { key: 'k', keyEnc: 'e' }])),
  }
}

function channel(sent, throws = false) {
  return { send: (frame) => { if (throws) throw new Error('socket closing'); sent.push(frame) } }
}

test('authorizedOn answers only for an identity bound on THAT socket', (t) => {
  resetRegistries()
  const a = { id: 'a' }
  const b = { id: 'b' }
  socketToPeers.set(a, new Set(['key1']))

  t.ok(authorizedOn(a, 'key1'), 'bound on this socket')
  t.absent(authorizedOn(a, 'key2'), 'a different identity on the same socket')
  t.absent(authorizedOn(b, 'key1'), 'the same identity on a different socket')
  t.absent(authorizedOn(undefined, 'key1'), 'no socket is not authorized')
})

// An owner reconnect leaves two sockets carrying the same identity until the old one closes, and
// both must answer true — a check against one current socket would deny the live one.
test('authorizedOn stays true on a draining socket after a reconnect', (t) => {
  resetRegistries()
  const oldSock = { id: 'old' }
  const newSock = { id: 'new' }
  socketToPeers.set(oldSock, new Set(['owner']))
  socketToPeers.set(newSock, new Set(['owner']))

  t.ok(authorizedOn(oldSock, 'owner'), 'the draining socket still answers')
  t.ok(authorizedOn(newSock, 'owner'), 'and so does the fresh one')
})

test('peersInSpace yields only the peers that share that space', (t) => {
  resetRegistries()
  connectedPeers.set('p1', peer({ id: 's1' }, ['space-a']))
  connectedPeers.set('p2', peer({ id: 's2' }, ['space-a', 'space-b']))
  connectedPeers.set('p3', peer({ id: 's3' }, ['space-b']))

  t.alike([...peersInSpace('space-a')].map(([k]) => k), ['p1', 'p2'])
  t.alike([...peersInSpace('space-b')].map(([k]) => k), ['p2', 'p3'])
  t.alike([...peersInSpace('space-c')].map(([k]) => k), [], 'a space nobody is in')
})

test('safeSend reports whether a frame reached a channel', (t) => {
  resetRegistries()
  const sock = { id: 's1' }
  const sent = []
  const p = peer(sock, ['space-a'])

  t.absent(safeSend(p, 'frame'), 'no channel for this socket yet')
  socketMsgHandlers.set(sock, channel(sent))
  t.ok(safeSend(p, 'frame'), 'sent once the channel is registered')
  t.alike(sent, ['frame'])
})

// One unreachable peer must not cost the rest of the space its frame.
test('a throwing channel does not abort the broadcast', (t) => {
  resetRegistries()
  const good = { id: 'good' }
  const bad = { id: 'bad' }
  const sent = []
  connectedPeers.set('bad', peer(bad, ['space-a']))
  connectedPeers.set('good', peer(good, ['space-a']))
  socketMsgHandlers.set(bad, channel(sent, true))
  socketMsgHandlers.set(good, channel(sent))

  t.is(broadcastToSpace('space-a', 'frame'), 1, 'one of two reached a channel')
  t.alike(sent, ['frame'], 'the healthy peer still got it')
})

test('broadcastToSpace sends once per peer in the space and to nobody else', (t) => {
  resetRegistries()
  const s1 = { id: 's1' }
  const s2 = { id: 's2' }
  const sent1 = []
  const sent2 = []
  connectedPeers.set('p1', peer(s1, ['space-a']))
  connectedPeers.set('p2', peer(s2, ['space-b']))
  socketMsgHandlers.set(s1, channel(sent1))
  socketMsgHandlers.set(s2, channel(sent2))

  t.is(broadcastToSpace('space-a', 'frame'), 1)
  t.alike(sent1, ['frame'])
  t.alike(sent2, [], 'a peer in another space is not a recipient')
})

test('detachPeerFromSpace drops the space and reports when none is left', (t) => {
  resetRegistries()
  const p = peer({ id: 's1' }, ['space-a', 'space-b'], ['space-a', 'space-b'])

  t.absent(detachPeerFromSpace(p, 'space-a'), 'still in space-b')
  t.absent(p.spaces.has('space-a'))
  t.absent(p.looseCatalogKeys.has('space-a'), 'the loose catalog key goes with the space')

  t.ok(detachPeerFromSpace(p, 'space-b'), 'now in no space at all')
  t.is(p.spaces.size, 0)
})

test('detachPeerFromSpace tolerates a peer with no loose catalog map', (t) => {
  const p = { socket: { id: 's1' }, spaces: new Map([['space-a', 'drive']]) }
  t.ok(detachPeerFromSpace(p, 'space-a'))
})

test('forgetPeerOnSocket drops the socket entry only once no identity rides it', (t) => {
  resetRegistries()
  const sock = { id: 's1' }
  socketToPeers.set(sock, new Set(['key1', 'key2']))

  forgetPeerOnSocket(sock, 'key1')
  t.ok(socketToPeers.has(sock), 'a second identity still rides this socket')
  t.absent(authorizedOn(sock, 'key1'))

  forgetPeerOnSocket(sock, 'key2')
  t.absent(socketToPeers.has(sock), 'the last identity takes the entry with it')
  forgetPeerOnSocket(sock, 'key2')
  t.absent(socketToPeers.has(sock), 'and forgetting an unknown socket is a no-op')
})

// The authorization rule has one implementation. content-peer-sockets.js is exempt on purpose: the
// identical-looking line there reads its OWN private socket→identities map for the content plane,
// not the swarm's.
test('no module re-inlines the authorization test', (t) => {
  const root = path.join(here, '..', '..', 'src', 'shared')
  const exempt = ['swarm-registries.js', 'content-peer-sockets.js']

  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name)
      if (statSync(p).isDirectory()) { if (name !== 'vendor') walk(p) }
      else if (name.endsWith('.js') && !exempt.includes(name)) files.push(p)
    }
  }
  walk(root)
  t.ok(files.length > 50, `walked ${files.length} modules`)

  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    t.absent(/socketToPeers\.get\([^)]*\)\?\.has\(/.test(src),
      `${path.relative(root, file)} calls authorizedOn rather than re-testing socketToPeers`)
  }
})
