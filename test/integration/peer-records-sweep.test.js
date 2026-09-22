import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { tagged } from '../helpers/capture-console.js'
import { createBee } from '../../src/shared/core/store.js'
import { flushAudit, record } from '../../src/shared/audit/audit-log.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'
import { getSeenVersion } from '../../src/shared/audit/audit-watch-state.js'
import { PeerWatch, observePeerProfile, sweep } from '../../src/shared/audit/peer-records-watch.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { getProfileBee } from '../../src/shared/spaces/profile.js'
import { publishShare } from '../../src/shared/shares/shares.js'

const PEER = 'c'.repeat(64)
const BEE_ID = 'profile:' + PEER

async function peerBee(t, name) {
  const bee = createBee(name)
  await bee.ready()
  t.teardown(() => bee.close())
  return bee
}

const rowsOf = async (kind) => (await queryAudit({})).entries.filter((e) => e.kind === kind)

// A peer bee already baselined, with one change past its watermark.
async function pendingChange(t) {
  await freshPeer(t)
  const bee = await peerBee(t, 'peer-sweep-fixture')
  await sweep(BEE_ID, bee, async () => {})
  const watermark = await getSeenVersion(BEE_ID)
  await bee.put('share/sp/one', { name: 'One' })
  return { bee, watermark }
}

const recordShare = () => record('peer.share_created', { subject: { id: 'one' } })

// REGRESSION (FIX-445: the watermark was written after the loop whatever apply did, so a row whose
// apply failed was stepped over and never recorded.)
test('REGRESSION (FIX-445: sweep advances past a lost row)', async (t) => {
  const { bee, watermark } = await pendingChange(t)
  let calls = 0
  const apply = async () => {
    if (calls++ === 0) throw new Error('transient')
    recordShare()
  }

  await sweep(BEE_ID, bee, apply)
  t.is(await getSeenVersion(BEE_ID), watermark, 'a failed row holds the watermark')

  await sweep(BEE_ID, bee, apply)
  t.is(await getSeenVersion(BEE_ID), bee.version, 'the replay that succeeds advances it')
  await sweep(BEE_ID, bee, apply)
  await flushAudit()
  t.is((await rowsOf('peer.share_created')).length, 1, 'the row is recorded exactly once')
})

test('REGRESSION (FIX-445: sweep advances past a lost row) — a row that always fails is given up after the cap', async (t) => {
  const { bee, watermark } = await pendingChange(t)
  const lines = tagged(t, '[peer-watch]', { levels: ['warn'], join: true })
  const apply = async () => { throw Object.assign(new Error('stuck'), { code: 'STUCK' }) }

  await sweep(BEE_ID, bee, apply)
  await sweep(BEE_ID, bee, apply)
  t.is(await getSeenVersion(BEE_ID), watermark, 'held through the first two failed sweeps')

  await sweep(BEE_ID, bee, apply)
  t.is(await getSeenVersion(BEE_ID), bee.version, 'the third failed sweep at one watermark advances it')
  t.ok(lines.some((l) => l.includes('lost') && l.includes('rows=' + watermark)), 'with a warn naming the lost row')
})

test('stopping the watch forgets the failed sweeps counted against the cap', async (t) => {
  const { bee, watermark } = await pendingChange(t)
  const watch = new PeerWatch('peer-watch-cycle')
  await watch.ready()
  const apply = async () => { throw new Error('stuck') }

  await sweep(BEE_ID, bee, apply)
  await sweep(BEE_ID, bee, apply)
  await watch.close()
  await sweep(BEE_ID, bee, apply)
  t.is(await getSeenVersion(BEE_ID), watermark, 'the first failure after a stop holds again')
})

// Reading our own shares only fails when the profile store is closed or not ready, which says
// nothing about who owns the share: the node is a failure to retry, not a mirror to skip.
test('REGRESSION (FIX-445: a failed own-share read skipped the mirror row)', async (t) => {
  await freshPeer(t)
  const { spaceId } = await createSpace('Mirrored')
  await publishShare(spaceId, { id: 'mine', name: 'Designs' })
  const bee = await peerBee(t, 'peer-mirror-fixture')
  await observePeerProfile(PEER, bee, { baselineOnly: true })
  const watermark = await getSeenVersion(BEE_ID)
  await bee.put('mirror/' + spaceId + '/mine', { syncState: 'synced' })

  const profile = getProfileBee()
  const read = profile.createReadStream
  profile.createReadStream = () => {
    profile.createReadStream = read
    throw Object.assign(new Error('session closed'), { code: 'SESSION_CLOSED' })
  }
  t.teardown(() => { profile.createReadStream = read })

  await observePeerProfile(PEER, bee)
  t.is(await getSeenVersion(BEE_ID), watermark, 'the node counts as failed and holds the watermark')

  await observePeerProfile(PEER, bee)
  await flushAudit()
  t.is((await rowsOf('mirror.peer_mirrored')).length, 1, 'the replay records the mirror row')
})
