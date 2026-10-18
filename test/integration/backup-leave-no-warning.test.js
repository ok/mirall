import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { freshPeer } from '../helpers/store.js'
import { tmpDir } from '../helpers/bare-tmp.js'
import { backupWrapKey, getStore } from '../../src/shared/core/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { getSpace, deleteSpaceRecord, upsertMember } from '../../src/shared/spaces/space.js'
import { forgetSpaceRecord, purgeSpace } from '../../src/shared/spaces/leave-records.js'
import { ownCatalog, purgeOwnCatalog } from '../../src/shared/shares/own-catalog.js'
import { listRecentRemovals } from '../../src/shared/storage/removal-evidence.js'
import { FolderTarget } from '../../src/shared/storage/backup/folder-target.js'
import { openRepo } from '../../src/shared/storage/backup/repo.js'
import { runBackup } from '../../src/shared/storage/backup/backup-run.js'
import { listCores, CORE_ROLE } from '../../src/shared/storage/backup/inventory.js'
import { keepSet } from '../../src/shared/storage/backup/retention.js'
import { listRestorable } from '../../src/shared/storage/backup/restore.js'

const MINUTE = 60 * 1000

// Three spaces, the first holding most of this person's own data.
async function threeSpaces(t) {
  const { storage } = await freshPeer(t)
  const spaces = [await createSpace('Falcon'), await createSpace('Harbor'), await createSpace('Orbit')]
  for (const [i, space] of spaces.entries()) {
    const catalog = await ownCatalog(space.spaceId)
    for (let n = 0; n < (i === 0 ? 300 : 5); n++) await catalog.put('row/' + n, { n })
  }
  const target = new FolderTarget(tmpDir('backup-leave-target', t))
  const base = Date.now()
  let repoId = null
  let step = 0
  const backUp = async (options = {}) => {
    const run = await runBackup({
      store: getStore(), storagePath: storage, target, wrapKey: backupWrapKey(), repoId, installId: 'i', appVersion: 't',
      now: () => base + step * MINUTE, ...options,
    })
    step++
    repoId = run.repoId
    t.ok(run.snapshot, 'the run wrote a snapshot')
    return run
  }
  const repo = () => openRepo(target, { wrapKey: backupWrapKey(), expectedRepoId: repoId })
  return { spaces, backUp, repo, at: () => base + step * MINUTE }
}

async function latestManifest(repo) {
  return (await repo.latestSnapshot()).manifest
}

test('REGRESSION (backup loss flag on a left space): leaving the biggest space, then sweeping it, is not a loss', async (t) => {
  const { spaces: [falcon], backUp, repo, at } = await threeSpaces(t)
  const healthy = await backUp()
  const record = await getSpace(falcon.spaceId)

  await forgetSpaceRecord(falcon.spaceId)
  const left = await backUp()
  t.is(left.latest.suspect, null, 'the leave itself is not a loss')
  t.is(left.latest.explained?.spaces, 1, 'the left space is taken out of the comparison')

  await purgeOwnCatalog(falcon.spaceId, record)
  const swept = await backUp()
  t.is(swept.latest.suspect, null, 'its catalog going is not a loss either')
  t.ok(swept.latest.explained?.ownLength > 0, 'the catalog the space left behind is what explained it')
  t.ok(swept.latest.explained?.cores >= 1)

  const opened = await repo()
  const newest = await latestManifest(opened)
  const snapshots = []
  for (const name of await opened.listSnapshots()) {
    const manifest = await opened.readSnapshot(name)
    snapshots.push({ name, createdAt: Date.parse(manifest.createdAt), suspect: manifest.suspect })
  }
  t.ok(keepSet(snapshots, at(), newest.departures).has(healthy.snapshot), 'the snapshot from before the leave is still pinned')
  const restorable = await listRestorable(opened)
  t.alike(restorable.find((s) => s.name === healthy.snapshot)?.beforeLeaving, ['Falcon'], 'and named as before leaving')
})

test('a leave and its sweep between two backups is not a loss', async (t) => {
  const { spaces: [falcon], backUp } = await threeSpaces(t)
  await backUp()
  const record = await getSpace(falcon.spaceId)
  await forgetSpaceRecord(falcon.spaceId)
  await purgeOwnCatalog(falcon.spaceId, record)
  const after = await backUp()
  t.is(after.latest.suspect, null)
  t.alike(after.latest.explained, { spaces: 1, cores: 1, ownLength: after.latest.explained.ownLength })
})

test('a discarded join is recorded as such and not a loss', async (t) => {
  const { spaces: [falcon], backUp } = await threeSpaces(t)
  await backUp()
  const record = await getSpace(falcon.spaceId)
  await purgeSpace(falcon.spaceId, { kind: 'join-discarded' })
  await purgeOwnCatalog(falcon.spaceId, record)
  t.is((await backUp()).latest.suspect, null)
  const [newest] = await listRecentRemovals(1)
  t.alike([newest.kind, newest.spaceId, newest.name], ['join-discarded', falcon.spaceId, 'Falcon'])
})

test('a space removed twice in one leave is recorded once', async (t) => {
  const { spaces: [falcon] } = await threeSpaces(t)
  await forgetSpaceRecord(falcon.spaceId)
  await purgeSpace(falcon.spaceId)
  t.is((await listRecentRemovals()).filter((entry) => entry.spaceId === falcon.spaceId).length, 1)
})

test('the catalog of a space still joined going missing is still a loss', async (t) => {
  const { spaces: [falcon], backUp } = await threeSpaces(t)
  await backUp()
  await purgeOwnCatalog(falcon.spaceId, await getSpace(falcon.spaceId))
  const after = await backUp()
  t.alike(after.latest.suspect?.reasons, ['own-data-shrank'], 'nothing a person did explains it')
  t.is(after.latest.explained, null)
})

test('spaces gone without the leave flow are still a loss', async (t) => {
  const { spaces: [falcon, harbor], backUp } = await threeSpaces(t)
  await backUp()
  await deleteSpaceRecord(falcon.spaceId)
  await deleteSpaceRecord(harbor.spaceId)
  t.alike((await backUp()).latest.suspect?.reasons, ['spaces-halved'])
})

test('a removal from before the last backup does not explain the live data of a space joined again', async (t) => {
  const { spaces: [falcon], backUp } = await threeSpaces(t)
  await backUp()
  await purgeOwnCatalog(falcon.spaceId, await getSpace(falcon.spaceId))
  const after = await backUp({ removedSpaces: async () => new Map([[falcon.spaceId, Date.now() - 60 * MINUTE]]) })
  t.alike(after.latest.suspect?.reasons, ['own-data-shrank'])
})

test('without the evidence, the same leave is flagged as before', async (t) => {
  const { spaces: [falcon], backUp } = await threeSpaces(t)
  await backUp()
  const record = await getSpace(falcon.spaceId)
  await forgetSpaceRecord(falcon.spaceId)
  await purgeOwnCatalog(falcon.spaceId, record)
  t.alike((await backUp({ removedSpaces: async () => new Map() })).latest.suspect?.reasons, ['own-data-shrank'])
})

test('a member\'s profile and catalog on disk are peer cores of its space', async (t) => {
  const { spaces: [falcon] } = await threeSpaces(t)
  const peerKey = crypto.keyPair().publicKey
  const peerCatalog = getStore().get({ key: peerKey })
  await peerCatalog.ready()
  const peerDk = b4a.toString(peerCatalog.discoveryKey, 'hex')
  await peerCatalog.close()
  const memberKey = crypto.keyPair().publicKey
  const memberProfile = getStore().get({ key: memberKey })
  await memberProfile.ready()
  const memberDk = b4a.toString(memberProfile.discoveryKey, 'hex')
  await memberProfile.close()
  await upsertMember(falcon.spaceId, { publicKey: b4a.toString(memberKey, 'hex'), looseCatalogKey: b4a.toString(peerKey, 'hex') })
  const listed = await listCores(getStore())
  const catalog = listed.find((core) => core.dk === peerDk)
  const profile = listed.find((core) => core.dk === memberDk)
  t.alike([catalog?.role, catalog?.spaceId], [CORE_ROLE.PEER, falcon.spaceId], 'their catalog')
  t.alike([profile?.role, profile?.spaceId], [CORE_ROLE.PEER, falcon.spaceId], 'their profile')
})

test('a left space\'s own catalog keeps the space it belonged to until it is swept', async (t) => {
  const { spaces: [falcon], backUp, repo } = await threeSpaces(t)
  await backUp()
  await forgetSpaceRecord(falcon.spaceId)
  await backUp()
  const cores = (await latestManifest(await repo())).cores.filter((core) => core.spaceId === falcon.spaceId)
  t.alike(cores.map((core) => core.role), [CORE_ROLE.OWN], 'the inventory no longer names it, but the entry keeps its space')
})
