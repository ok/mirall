import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { until } from '../helpers/bare-poll.js'
import { tagged } from '../helpers/capture-console.js'
import { createBee } from '../../src/shared/core/store.js'
import { auditBee, flushAudit, record } from '../../src/shared/audit/audit-log.js'
import { PSTATE, SEEN } from '../../src/shared/audit/audit-keys.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'
import { getSeenVersion } from '../../src/shared/audit/audit-watch-state.js'
import { PeerWatch, _sweepRetryForTests, observePeerProfile, sweep } from '../../src/shared/audit/peer-records-watch.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { getProfileBee } from '../../src/shared/spaces/profile.js'
import { SHARE_PREFIX, publishShare } from '../../src/shared/shares/shares.js'

const PEER = 'c'.repeat(64)
const BEE_ID = 'profile:' + PEER

async function peerBee(t, name) {
  const bee = createBee(name)
  await bee.ready()
  t.teardown(() => bee.close())
  return bee
}

const rowsOf = async (kind) => (await queryAudit({})).entries.filter((e) => e.kind === kind)
const kindsInOrder = async (prefix) => (await queryAudit({})).entries
  .filter((e) => e.kind.startsWith(prefix)).sort((a, b) => a.seq - b.seq).map((e) => e.kind)
const fault = (code) => Object.assign(new Error('fault ' + code), { code })

// A peer bee already baselined, with one change past its watermark.
async function pendingChange(t) {
  await freshPeer(t)
  const bee = await peerBee(t, 'peer-sweep-fixture')
  await sweep(BEE_ID, bee, async () => {})
  const watermark = await getSeenVersion(BEE_ID)
  await bee.put('share/sp/one', { name: 'One' })
  return { bee, watermark }
}

// A space of ours holding a share of ours, and a baselined peer profile bee.
async function mirroredShare(t) {
  await freshPeer(t)
  const { spaceId } = await createSpace('Mirrored')
  await publishShare(spaceId, { id: 'mine', name: 'Designs' })
  const bee = await peerBee(t, 'peer-mirror-fixture')
  await observePeerProfile(PEER, bee)
  return { spaceId, bee, watermark: await getSeenVersion(BEE_ID) }
}

// Fails only the read of our own shares in one space, the one the mirror gate makes; every other
// read of the profile bee passes through.
function failOwnShareReads(t, spaceId, { once = false } = {}) {
  const profile = getProfileBee()
  const read = profile.createReadStream
  const prefix = SHARE_PREFIX + spaceId + '/'
  const lift = () => { profile.createReadStream = read }
  profile.createReadStream = (range, ...rest) => {
    if (range?.gte !== prefix) return read.call(profile, range, ...rest)
    if (once) lift()
    throw fault('SESSION_CLOSED')
  }
  t.teardown(lift)
  return lift
}

function failAuditPuts(t, prefix, { once = false } = {}) {
  const bee = auditBee()
  const put = bee.put
  const lift = () => { bee.put = put }
  bee.put = (key, ...rest) => {
    if (typeof key !== 'string' || !key.startsWith(prefix)) return put.call(bee, key, ...rest)
    if (once) lift()
    return Promise.reject(fault('EIO'))
  }
  t.teardown(lift)
  return lift
}

const recordShare = () => record('peer.share_created', { subject: { id: 'one' } })

// REGRESSION (FIX-445: the watermark was written after the loop whatever apply did, so a row whose
// apply failed was stepped over and never recorded.)
test('REGRESSION (FIX-445: sweep advances past a lost row)', async (t) => {
  const { bee, watermark } = await pendingChange(t)
  let calls = 0
  const apply = async () => {
    if (calls++ === 0) throw fault('TRANSIENT')
    recordShare()
  }

  await sweep(BEE_ID, bee, apply)
  t.is(await getSeenVersion(BEE_ID), watermark, 'a failed row holds the watermark')

  await sweep(BEE_ID, bee, apply)
  t.is(await getSeenVersion(BEE_ID), bee.version, 'the retry that succeeds advances it')
  await sweep(BEE_ID, bee, apply)
  await flushAudit()
  t.is((await rowsOf('peer.share_created')).length, 1, 'the row is recorded exactly once')
})

test('REGRESSION (FIX-445: sweep advances past a lost row) — a row that keeps failing is given up with every cause named', async (t) => {
  const { bee, watermark } = await pendingChange(t)
  _sweepRetryForTests({ attempts: 3, giveUpAgeMs: 0 })
  const lines = tagged(t, '[peer-watch]', { levels: ['warn'], join: true })
  const codes = ['STUCK_A', 'STUCK_B', 'STUCK_A']
  const apply = async () => { throw fault(codes.shift()) }

  await sweep(BEE_ID, bee, apply)
  await sweep(BEE_ID, bee, apply)
  t.is(await getSeenVersion(BEE_ID), watermark, 'held through the first two failures')

  await sweep(BEE_ID, bee, apply)
  t.is(await getSeenVersion(BEE_ID), bee.version, 'the third failure of the row advances past it')
  const lost = lines.find((l) => l.includes('lost'))
  t.ok(lost?.includes('row=' + watermark), 'the warn names the lost row')
  t.ok(lost?.includes('STUCK_A') && lost?.includes('STUCK_B'), 'and each distinct cause')
})

test('a failing row is not given up before the minimum age, however fast the appends come', async (t) => {
  const { bee, watermark } = await pendingChange(t)
  _sweepRetryForTests({ attempts: 3, giveUpAgeMs: 60000 })
  const apply = async () => { throw fault('STUCK') }

  for (let i = 0; i < 5; i++) await sweep(BEE_ID, bee, apply)
  t.is(await getSeenVersion(BEE_ID), watermark, 'still held')
})

test('a failure count survives a watermark write that fails', async (t) => {
  const { bee, watermark } = await pendingChange(t)
  _sweepRetryForTests({ attempts: 3, giveUpAgeMs: 0 })
  const fail = async () => { throw fault('STUCK') }

  await sweep(BEE_ID, bee, fail)
  await sweep(BEE_ID, bee, fail)
  failAuditPuts(t, SEEN, { once: true })
  await sweep(BEE_ID, bee, async () => {}).catch(() => {})
  t.is(await getSeenVersion(BEE_ID), watermark, 'precondition: the advancing write failed')

  await sweep(BEE_ID, bee, fail)
  t.is(await getSeenVersion(BEE_ID), bee.version, 'the third failure still gives the row up')
})

test('stopping the watch forgets the failures counted against a row', async (t) => {
  const { bee, watermark } = await pendingChange(t)
  const watch = new PeerWatch('peer-watch-cycle')
  await watch.ready()
  _sweepRetryForTests({ attempts: 3, giveUpAgeMs: 0 })
  const apply = async () => { throw fault('STUCK') }

  await sweep(BEE_ID, bee, apply)
  await sweep(BEE_ID, bee, apply)
  await watch.close()
  _sweepRetryForTests({ attempts: 3, giveUpAgeMs: 0 })
  await sweep(BEE_ID, bee, apply)
  t.is(await getSeenVersion(BEE_ID), watermark, 'the first failure after a stop holds again')
})

test('the backlog-skip warning is logged once, when the skip is taken', async (t) => {
  await freshPeer(t)
  const bee = await peerBee(t, 'peer-backlog-fixture')
  await sweep(BEE_ID, bee, async () => {})
  const batch = bee.batch()
  for (let i = 0; i < 510; i++) await batch.put('share/sp/s' + i, { name: 's' + i })
  await batch.flush()
  const lines = tagged(t, '[peer-watch]', { levels: ['warn'], join: true })
  let failures = 2
  const apply = async () => { if (failures-- > 0) throw fault('TRANSIENT') }

  await sweep(BEE_ID, bee, apply)
  await sweep(BEE_ID, bee, apply)
  await sweep(BEE_ID, bee, apply)
  t.is(await getSeenVersion(BEE_ID), bee.version, 'precondition: the backlog was skipped to the head')
  t.is(lines.filter((l) => l.includes('more ops')).length, 1, 'one warning for the one skip')
})

// Reading our own shares only fails when the profile store is closed or not ready, which says
// nothing about who owns the share: the node is a failure to retry, not a mirror to skip.
test('REGRESSION (FIX-445: a failed own-share read skipped the mirror row)', async (t) => {
  const { spaceId, bee, watermark } = await mirroredShare(t)
  await bee.put('mirror/' + spaceId + '/mine', { syncState: 'synced' })

  const lift = failOwnShareReads(t, spaceId)
  await observePeerProfile(PEER, bee)
  lift()
  t.is(await getSeenVersion(BEE_ID), watermark, 'the node counts as failed and holds the watermark')

  await observePeerProfile(PEER, bee)
  await flushAudit()
  t.is((await rowsOf('mirror.peer_mirrored')).length, 1, 'the retry records the mirror row')
})

// REGRESSION (FIX-445: replaying the whole batch re-applied the rows before the failed one, so a
// subject that flipped inside the batch recorded each flip again.)
test('REGRESSION (FIX-445: a replay re-recorded the rows before the failed one)', async (t) => {
  const { spaceId, bee } = await mirroredShare(t)
  await bee.put('share/' + spaceId + '/theirs', { name: 'Theirs' })
  await bee.put('share/' + spaceId + '/theirs', { name: 'Theirs', deletedAt: 1 })
  await bee.put('mirror/' + spaceId + '/mine', { syncState: 'synced' })

  const lift = failOwnShareReads(t, spaceId)
  await observePeerProfile(PEER, bee)
  lift()
  await observePeerProfile(PEER, bee)
  await flushAudit()
  t.alike(await kindsInOrder('peer.share'), ['peer.share_created', 'peer.share_deleted'], 'each flip once')
  t.is((await rowsOf('mirror.peer_mirrored')).length, 1, 'and the held row once')
})

// REGRESSION (FIX-445: rows after a failed one were applied ahead of it, so a retried mirror
// landed after the unmirror that followed it.)
test('REGRESSION (FIX-445: a later row was recorded ahead of a failed one)', async (t) => {
  const { spaceId, bee } = await mirroredShare(t)
  await bee.put('mirror/' + spaceId + '/mine', { syncState: 'synced' })
  await bee.put('mirror/' + spaceId + '/mine', { syncState: 'synced', unmirroredAt: 1 })

  failOwnShareReads(t, spaceId, { once: true })
  await observePeerProfile(PEER, bee)
  await observePeerProfile(PEER, bee)
  await flushAudit()
  t.alike(await kindsInOrder('mirror.'), ['mirror.peer_mirrored', 'mirror.peer_unmirrored'], 'in the peer\'s order, once each')
})

// REGRESSION (FIX-445: a subject-state write failing after the row was admitted counted the row
// as lost, and its retry recorded it again.)
test('REGRESSION (FIX-445: an admitted row whose state write failed was recorded again)', async (t) => {
  const { spaceId, bee } = await mirroredShare(t)
  await bee.put('share/' + spaceId + '/theirs', { name: 'Theirs' })
  const lines = tagged(t, '[peer-watch]', { levels: ['warn'], join: true })

  const lift = failAuditPuts(t, PSTATE)
  await observePeerProfile(PEER, bee)
  lift()
  t.is(await getSeenVersion(BEE_ID), bee.version, 'an admitted row is done for the watermark')
  t.ok(lines.some((l) => l.includes('subject state')), 'the lost state write is warned')

  await observePeerProfile(PEER, bee)
  await flushAudit()
  t.is((await rowsOf('peer.share_created')).length, 1, 'the row is not recorded again')
})

// REGRESSION (FIX-445: only a peer append swept a bee, so a held row of a peer that went quiet
// was never retried.)
test('REGRESSION (FIX-445: a held row of a quiet peer was never retried)', async (t) => {
  const { spaceId, bee } = await mirroredShare(t)
  _sweepRetryForTests({ delaysMs: [50] })
  await bee.put('mirror/' + spaceId + '/mine', { syncState: 'synced' })

  const lift = failOwnShareReads(t, spaceId)
  await observePeerProfile(PEER, bee)
  lift()
  t.ok(await until(async () => (await rowsOf('mirror.peer_mirrored')).length === 1, 5000), 'the retry fires on its own')
  t.is(await getSeenVersion(BEE_ID), bee.version, 'and advances the watermark')
})
