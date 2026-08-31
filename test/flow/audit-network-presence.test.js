import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

// Production waits five minutes before calling a peer gone; that is tuning, not a contract, and
// five minutes of wall-clock is not a test. Everything else here is real: two peers, a real
// handshake, a real socket teardown.
const PRESENCE_DWELL_MS = 2000

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const flags = () => ({
  identityKEK: kekHex(),
  handshakeIdentityBindingEnabled: true,
  peerPresenceDwellMs: PRESENCE_DWELL_MS,
})

const kindsOf = (entries) => entries.map((e) => e.kind)
const find = (entries, kind) => entries.find((e) => e.kind === kind)

async function rows (peer) {
  return (await peer.request('audit:list', { limit: 200 })).entries
}

test('a peer that really goes away is recorded once, and its return closes the row', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const storageB = idStore(t)
  const downloadsB = mkTmpDir(t)
  const kekB = kekHex()
  const flagsB = { ...flags(), identityKEK: kekB }

  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: storageB, downloads: downloadsB, flags: flagsB })

  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const bKey = (await B.request('profile:get')).publicKey

  B.kill()

  await A.until('audit:list', { limit: 200 }, (page) => kindsOf(page.entries).includes('network.peer_lost'), { ms: 60000 })
  const lost = find(await rows(A), 'network.peer_lost')
  t.is(lost.tier, 'B', 'the socket was authenticated, so the absence is attributable')
  t.is(lost.actor.key, bKey, 'the real remote profile key, not a claimed one')
  t.is(lost.actor.name, 'Bob', 'the name is snapshotted, so the row survives the roster')
  t.is(lost.space.id, spaceId, 'presence is per space')
  t.ok(lost.subject.sinceTs > 0, 'and the row names when the absence began')

  const B2 = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: storageB, downloads: downloadsB, flags: flagsB })
  t.teardown(() => B2.kill())

  await A.until('audit:list', { limit: 200 }, (page) => kindsOf(page.entries).includes('network.peer_back'), { ms: 90000 })
  const back = find(await rows(A), 'network.peer_back')
  t.is(back.actor.key, bKey)
  t.ok(back.subject.durationMs >= PRESENCE_DWELL_MS, 'the return row carries how long the absence lasted')

  const all = await rows(A)
  t.is(all.filter((e) => e.kind === 'network.peer_lost').length, 1, 'one absence, one row')
})

// member.left already tells that story; a second row seconds later reads as two separate events.
test('leaving the space is a leave, not a disconnect', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })

  const spaceId = await connectInSpaceWithApproval(t, A, B)
  await B.request('space:leave', { spaceId })

  await A.until('audit:list', { limit: 200 }, (page) => kindsOf(page.entries).includes('member.left'), { ms: 60000 })
  await new Promise((resolve) => setTimeout(resolve, PRESENCE_DWELL_MS * 3))

  const all = await rows(A)
  t.ok(find(all, 'member.left'), 'the leave is recorded')
  t.absent(find(all, 'network.peer_lost'), 'and not doubled as a connectivity loss')
})
