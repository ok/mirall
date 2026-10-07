import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { setRuntimeConfig, setDownloadFolder } from '../../src/shared/core/runtime-config.js'
import { boot } from '../../src/worker/boot.js'
import { backupWrapKey, getStore, createLocalBee } from '../../src/shared/core/store.js'
import { setProfile } from '../../src/shared/spaces/profile.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { deleteSpaceRecord } from '../../src/shared/spaces/space.js'
import { registerBackup } from '../../src/worker/ipc/backup.js'
import { createPassphraseThrottle } from '../../src/shared/core/identity-recovery.js'
import { writeRestoreHold, PROFILE_BEE } from '../../src/shared/core/restore-hold.js'
import { MAIN_REQUEST_FRAME, MAIN_REQUEST } from '../../src/shared/contract/main-requests.js'
import { FolderTarget, REPO_DIR } from '../../src/shared/storage/backup/folder-target.js'
import { openRepo } from '../../src/shared/storage/backup/repo.js'
import { runBackup } from '../../src/shared/storage/backup/backup-run.js'
import { pruneRepo } from '../../src/shared/storage/backup/prune.js'
import { offlineMemberRegistry } from '../helpers/store.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { tmpDir } from '../helpers/bare-tmp.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const DAY = 24 * 60 * 60 * 1000

function dirs(t) {
  const home = tmpDir('backup-service')
  const storage = path.join(home, 'app-storage')
  fs.mkdirSync(storage, { recursive: true })
  const downloads = tmpDir('backup-service-dl')
  const backupFolder = tmpDir('backup-service-target')
  t.teardown(() => {
    for (const dir of [home, downloads, backupFolder]) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
  }, { order: 2 })
  return { home, storage, downloads, backupFolder }
}

async function bootWith(t, { configured = true, repoId = null } = {}) {
  const d = dirs(t)
  const config = {
    storage: d.storage, appVersion: '0.0.0-test', dev: true, verbose: false, downloadFolder: d.downloads,
    backupFolder: configured ? d.backupFolder : null, backupRepoId: repoId,
  }
  setRuntimeConfig(config)
  setDownloadFolder(d.downloads)
  const fake = createFakeIpc()
  const masterSecret = crypto.randomBytes(32)
  const root = await boot(config, { ipc: fake.ipc, log: quiet, swarm: false, masterSecret, memberRegistry: offlineMemberRegistry })
  t.teardown(async () => { try { await root.close() } catch {} }, { order: 1 })
  registerBackup(fake.ipc, { backup: root.backup, paused: root.backupPaused, openRecovery: createPassphraseThrottle() })
  await setProfile({ displayName: 'Backed' })
  return { ...d, root, fake, masterSecret }
}

// The same data folder booted again, as after a restart.
async function bootWithStorage(t, previous, { folder, repoId }) {
  const config = {
    storage: previous.storage, appVersion: '0.0.0-test', dev: true, verbose: false, downloadFolder: previous.downloads,
    backupFolder: folder, backupRepoId: repoId,
  }
  setRuntimeConfig(config)
  const fake = createFakeIpc()
  const root = await boot(config, { ipc: fake.ipc, log: quiet, swarm: false, masterSecret: previous.masterSecret, memberRegistry: offlineMemberRegistry })
  t.teardown(async () => { try { await root.close() } catch {} }, { order: 1 })
  registerBackup(fake.ipc, { backup: root.backup, paused: root.backupPaused, openRecovery: createPassphraseThrottle() })
  return { root, fake }
}

async function codeOf(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err.code
  }
}

const remembered = (fake) => fake.events.filter((e) => e.type === MAIN_REQUEST_FRAME && e.payload.command === MAIN_REQUEST.BACKUP_REMEMBER).map((e) => e.payload.args)

test('a run writes a snapshot, reports it, and has main remember the new repository', async (t) => {
  const { fake } = await bootWith(t)
  const status = await fake.call('backup:run', {})
  t.is(status.state, 'idle')
  t.ok(status.lastSnapshot)
  t.ok(status.repoId)
  t.alike(remembered(fake).at(-1), { folder: status.folder, repoId: status.repoId })
  t.ok(fake.emitted('event:storage-updated').length > 0, 'the Storage screen is told')
})

test('a change worth backing up arms the next run', async (t) => {
  const { root } = await bootWith(t)
  await root.backup().run('manual')
  await setProfile({ displayName: 'Changed' })
  t.is(root.backup().dirty?.urgency, 'normal', 'an everyday change')
  t.ok(root.backup().wake, 'and a run is scheduled')
  await createSpace('Urgent')
  t.is(root.backup().dirty?.urgency, 'urgent', 'a new space is urgent')
})

test('the folder can never be inside the app data folder, and a new folder starts a new backup', async (t) => {
  const { fake, home } = await bootWith(t)
  t.is(await codeOf(fake.call('backup:configure', { folder: path.join(home, 'inside') })), 'INVALID_ARGUMENT')
  const other = tmpDir('backup-service-other')
  t.teardown(() => { try { fs.rmSync(other, { recursive: true, force: true }) } catch {} }, { order: 2 })
  const status = await fake.call('backup:configure', { folder: other })
  t.is(status.folder, other)
  t.is(status.repoId, null)
  t.alike(remembered(fake).at(-1), { folder: other, repoId: null })
  t.is((await fake.call('backup:turn-off', {})).state, 'off')
})

test('a change still unsaved at quit is backed up on the way out', async (t) => {
  const { root, backupFolder, fake } = await bootWith(t)
  await fake.call('backup:run', {})
  await setProfile({ displayName: 'At quit' })
  await root.close()
  t.is(fs.readdirSync(path.join(backupFolder, REPO_DIR, 'snapshots')).length, 2, 'a second snapshot was written at close')
})

test('losing spaces marks a snapshot suspect, and pruning keeps the healthy ones', async (t) => {
  const { fake, backupFolder } = await bootWith(t)
  const a = await createSpace('One')
  const b = await createSpace('Two')
  const healthy = await fake.call('backup:run', {})
  t.is(healthy.suspect, null)
  await deleteSpaceRecord(a.spaceId)
  await deleteSpaceRecord(b.spaceId)
  const lost = await fake.call('backup:run', {})
  t.alike(lost.suspect, ['spaces-halved'], 'the status warns, with the reason')
  const repo = await openRepo(new FolderTarget(backupFolder), { wrapKey: backupWrapKey(), expectedRepoId: healthy.repoId })
  const { manifest } = await repo.latestSnapshot()
  t.alike(manifest.suspect.reasons, ['spaces-halved'])
  t.is((await repo.latestUnflagged()).name, healthy.lastSnapshot, 'the last unflagged snapshot is still the reference')
  await pruneRepo(repo, { now: Date.now() + 400 * DAY })
  t.ok((await repo.listSnapshots()).includes(healthy.lastSnapshot), 'pruning never takes the last healthy snapshot')
})

test('pruning removes snapshots retention does not keep and the objects only they named', async (t) => {
  // No folder configured, so the service never runs on its own beside the passes this test makes.
  const { storage, backupFolder } = await bootWith(t, { configured: false })
  const target = new FolderTarget(backupFolder)
  const base = Date.now() - 10 * DAY
  let repoId = null
  const names = []
  const reclaim = createLocalBee('reclaim-meta')
  await reclaim.ready()
  for (let i = 0; i < 6; i++) {
    await setProfile({ displayName: 'Step ' + i })
    // Halfway, one core starts over: the parts of its old chain are named only by the older snapshots.
    if (i === 3) await reclaim.core.truncate(0)
    await reclaim.put('step', i)
    const run = await runBackup({ store: getStore(), storagePath: storage, target, wrapKey: backupWrapKey(), repoId, installId: 'i', appVersion: 't', now: () => base + i * 60 * 1000 })
    repoId = run.repoId
    names.push(run.snapshot)
  }
  const objectsDir = path.join(backupFolder, REPO_DIR, 'objects')
  const old = (Date.now() - 20 * DAY) / 1000
  for (const prefix of fs.readdirSync(objectsDir)) for (const id of fs.readdirSync(path.join(objectsDir, prefix))) fs.utimesSync(path.join(objectsDir, prefix, id), old, old)
  const repo = await openRepo(target, { wrapKey: backupWrapKey(), expectedRepoId: repoId })
  const before = (await repo.objectIds()).length
  const pruned = await pruneRepo(repo)
  t.is(pruned.snapshots, 5, 'six snapshots minutes apart, ten days ago: only the newest stays')
  t.alike(await repo.listSnapshots(), names.slice(5))
  t.ok(pruned.objects > 0 && (await repo.objectIds()).length === before - pruned.objects)
  const { manifest } = await repo.latestSnapshot()
  for (const core of manifest.cores) for (const segment of core.segments) for (const id of segment.parts) await repo.readPart(id)
  t.pass('every part the kept snapshots name is still readable')
  await reclaim.close()
})

test('files a folder browser leaves in the backup do not stop pruning', async (t) => {
  const { fake, backupFolder } = await bootWith(t)
  const status = await fake.call('backup:run', {})
  const objects = path.join(backupFolder, REPO_DIR, 'objects')
  fs.writeFileSync(path.join(objects, '.DS_Store'), 'x')
  const prefix = fs.readdirSync(objects).find((n) => /^[0-9a-f]{2}$/.test(n))
  fs.writeFileSync(path.join(objects, prefix, '._' + prefix), 'x')
  const repo = await openRepo(new FolderTarget(backupFolder), { wrapKey: backupWrapKey(), expectedRepoId: status.repoId })
  t.absent((await repo.objectIds()).some((id) => id.startsWith('.')))
  await pruneRepo(repo)
  t.pass('pruned')
})

test('changes made while a run goes are kept for the next run; earlier ones are done', async (t) => {
  const { root } = await bootWith(t)
  root.backup().note('urgent')
  const run = root.backup().run('manual')
  root.backup().note('normal')
  await run
  t.is(root.backup().dirty?.urgency, 'normal', 'only the change that came during the run is still due')
})

test('settings that are not preferences do not make a run look changed', async (t) => {
  const { root, home } = await bootWith(t)
  const configFile = path.join(home, 'config.json')
  fs.writeFileSync(configFile, JSON.stringify({ appearance: { theme: 'dark' }, window: { bounds: { x: 1 } } }))
  await root.backup().run('manual')
  fs.writeFileSync(configFile, JSON.stringify({ appearance: { theme: 'dark' }, window: { bounds: { x: 200 } } }))
  const again = await root.backup().run('manual')
  t.ok(again.lastSnapshot)
  const before = again.lastSnapshot
  t.is((await root.backup().run('manual')).lastSnapshot, before, 'moving the window wrote no snapshot')
})

test('after a restart the status shows the latest snapshot and its flag again', async (t) => {
  const first = await bootWith(t)
  const a = await createSpace('One')
  const b = await createSpace('Two')
  await first.fake.call('backup:run', {})
  await deleteSpaceRecord(a.spaceId)
  await deleteSpaceRecord(b.spaceId)
  const flagged = await first.fake.call('backup:run', {})
  t.alike(flagged.suspect, ['spaces-halved'])
  const folder = flagged.folder
  const repoId = flagged.repoId
  await first.root.close()

  const second = await bootWithStorage(t, first, { folder, repoId })
  const status = await second.fake.call('backup:run', {})
  t.ok(status.lastSnapshot, 'the status names the latest snapshot')
  t.alike(status.suspect, ['spaces-halved'], 'and still warns: the drop is measured against the snapshot before it')
  t.is((await second.fake.call('backup:run', {})).lastSnapshot, status.lastSnapshot, 'a run with nothing new keeps naming it')
})

test('while a restore is catching up, the backup reports itself paused', async (t) => {
  const d = dirs(t)
  await writeRestoreHold(d.storage, [PROFILE_BEE], 'backup')
  const config = { storage: d.storage, appVersion: 't', dev: true, verbose: false, downloadFolder: d.downloads, backupFolder: d.backupFolder, backupRepoId: null }
  setRuntimeConfig(config)
  setDownloadFolder(d.downloads)
  const fake = createFakeIpc()
  const root = await boot(config, { ipc: fake.ipc, log: quiet, swarm: false, masterSecret: crypto.randomBytes(32), memberRegistry: offlineMemberRegistry })
  t.teardown(async () => { try { await root.close() } catch {} }, { order: 1 })
  registerBackup(fake.ipc, { backup: root.backup, paused: root.backupPaused, openRecovery: createPassphraseThrottle() })
  t.is(root.backup(), null)
  const status = await fake.call('backup:status', {})
  t.is(status.state, 'paused')
})
