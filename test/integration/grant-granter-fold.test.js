import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { freshPeer } from '../helpers/store.js'
import { makePeer, replicate } from '../helpers/peer-bee.js'
import { getStore } from '../../src/shared/core/store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { foldHoldsMember } from '../../src/shared/spaces/member-view.js'

// A pending joiner vets a granter that is neither the invite's inviter nor its creator by folding
// the member set rooted at the creator from the bees it already replicates. An unreadable root
// holds nobody, so the check fails closed inside the read budget.

const S = 'space-granter'
const hex = () => b4a.toString(crypto.randomBytes(32), 'hex')

function withConfig(t, patch) {
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, ...patch })
  t.teardown(() => setRuntimeConfig(prev))
}

async function memberTree(t) {
  await freshPeer(t)
  withConfig(t, { peerReadTimeoutMs: 1000 })
  const creator = await makePeer(t)
  const coMember = await makePeer(t)
  await creator.bee.put('member/' + S, { active: true, ts: 1 })
  await creator.bee.put('approved/' + S + '/' + coMember.key, { ts: 1 })
  await coMember.bee.put('member/' + S, { active: true, ts: 1 })
  replicate(getStore(), creator.store, t)
  replicate(getStore(), coMember.store, t)
  return { creator, coMember }
}

test('the fold rooted at the creator holds a co-member the creator approved', async (t) => {
  const { creator, coMember } = await memberTree(t)
  t.ok(await foldHoldsMember({ spaceId: S, creatorKey: creator.key, key: coMember.key }))
})

test('the fold does not hold a key nobody in the tree approved', async (t) => {
  const { creator } = await memberTree(t)
  t.absent(await foldHoldsMember({ spaceId: S, creatorKey: creator.key, key: hex() }))
})

test('an unreadable creator holds nobody, answered within the read budget', async (t) => {
  const { coMember } = await memberTree(t)
  const t0 = Date.now()
  // absolute: peerReadTimeoutMs is the budget under test; two reads (root and self) bound the check.
  const held = await foldHoldsMember({ spaceId: S, creatorKey: hex(), key: coMember.key })
  const dt = Date.now() - t0
  t.absent(held, 'fails closed')
  t.ok(dt < 3000, 'inside the read budget (' + dt + 'ms)')
})
