import test from 'brittle'
import crypto from 'crypto'
import hcrypto from 'hypercore-crypto'
import path from 'path'
import b4a from 'b4a'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { rawPeer } from '../helpers/raw-peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { decodeInvite } from '../../src/shared/invite-envelope.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
// Identity mode + membership approval + binding ENFORCED.
const bindFlags = () => ({ identityKEK: kekHex(), membershipApprovalEnabled: true, handshakeIdentityBindingEnabled: true })

const memberKeys = async (peer, spaceId) => {
  const list = await peer.request('spaces:list')
  const s = list.find((x) => x.spaceId === spaceId)
  return new Set((s?.members || []).map((m) => m.publicKey))
}

async function topicFor (peer, spaceId) {
  const inviteCode = await peer.request('space:invite', { spaceId })
  return decodeInvite(inviteCode).topic
}

// Positive path: with binding enforced, honest peers (each signing their own Noise key)
// still approve and converge. If the capability/sig wiring were wrong this would hang.
test('binding ON: honest peers approve and converge', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })

  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey

  t.ok((await memberKeys(A, spaceId)).has(bKey), 'A sees B as a member')
  t.ok((await memberKeys(B, spaceId)).has(aKey), 'B sees A as a member')
})

// REGRESSION (MIR-03): an attacker that knows a member's public profileKey cannot
// impersonate them — a handshake without a valid Noise-key binding is rejected, so the
// follow-up leave frame for the victim is not authenticated and the victim stays.
test('REGRESSION (MIR-03): spoofed handshake cannot impersonate or evict a member', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })

  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const bKey = (await B.request('profile:get')).publicKey
  const topic = await topicFor(A, spaceId)
  B.kill()

  const atk = await rawPeer(t, { bootstrap, topicHex: topic })
  await atk.waitConnected()
  // Claim Bob's key with no valid binding (the attacker can't sign Bob's Noise key),
  // then try to leave on Bob's behalf.
  atk.send({ type: 'handshake', profileKey: bKey, driveKey: b4a.toString(hcrypto.randomBytes(32), 'hex'), displayName: 'Bob', spaceTopic: topic })
  atk.send({ type: 'leave', spaceId, profileKey: bKey })

  await new Promise((r) => setTimeout(r, 3000))
  t.ok((await memberKeys(A, spaceId)).has(bKey), 'victim B remains a member after the spoof')
  t.ok(A.readStderr().includes('identity-unbound'), 'A logged the binding rejection')
})

// REGRESSION (MIR-03-A): a spoofed membership:request must not trigger an SCK re-grant.
// A member that is a known member + currently offline would otherwise have its grant
// routed (via the pendingRequesters fallback) to whoever sent the request.
test('REGRESSION (MIR-03-A): spoofed join request gets no SCK grant', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })

  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const bKey = (await B.request('profile:get')).publicKey
  const topic = await topicFor(A, spaceId)
  B.kill()

  const atk = await rawPeer(t, { bootstrap, topicHex: topic })
  await atk.waitConnected()
  atk.send({ type: 'membership:request', profileKey: bKey, displayName: 'Bob', spaceTopic: topic })

  await t.exception(
    atk.waitFrame((m) => m.type === 'membership:grant', 8000),
    /no matching frame/,
    'attacker received no SCK grant',
  )
})
