import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Corestore from 'corestore'
import { freshPeer } from '../helpers/store.js'
import { tmpDir } from '../helpers/bare-tmp.js'
import { getStore, backupWrapKey } from '../../src/shared/core/store.js'
import { setProfile } from '../../src/shared/spaces/profile.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { advertise } from '../../src/shared/shares/own-catalog.js'
import { FolderTarget, REPO_DIR } from '../../src/shared/storage/backup/folder-target.js'
import { openOrInitRepo, openRepo } from '../../src/shared/storage/backup/repo.js'
import { runBackup } from '../../src/shared/storage/backup/backup-run.js'
import { decodePart } from '../../src/shared/storage/backup/segment-codec.js'
import { applyRecord } from '../../src/shared/storage/backup/core-proofs.js'

function folder(t, label = 'backup-target') {
  const dir = tmpDir(label)
  t.teardown(() => {
    try { fs.chmodSync(dir, 0o700) } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }, { order: 2 })
  return dir
}

async function codeOf(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err.code
  }
}

function filesUnder(dir) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) out.push(...filesUnder(p))
    else out.push(p)
  }
  return out
}

const runArgs = (target, repoId, over = {}) => ({
  store: getStore(), target, wrapKey: backupWrapKey(), repoId,
  installId: 'install-a', appVersion: '0.0.0-test', config: b4a.from('{"theme":"dark"}'), ...over,
})

test('the target writes once, lists and replaces only its own files', async (t) => {
  const target = new FolderTarget(folder(t))
  await target.ready({ create: true })
  t.is(await target.putOnce('objects/ab/one', b4a.from('1')), 'written')
  t.is(await target.putOnce('objects/ab/one', b4a.from('different')), 'exists', 'a name is never rewritten')
  t.alike(await target.read('objects/ab/one'), b4a.from('1'))
  t.alike(await target.list('objects/ab'), ['one'])
  t.alike(await target.list('nothing-here'), [])
  await target.replaceOwn('leases/me.json', b4a.from('a'))
  await target.replaceOwn('leases/me.json', b4a.from('b'))
  t.alike(await target.read('leases/me.json'), b4a.from('b'))
  t.alike(await target.list('tmp'), [], 'no temporary file is left behind')
})

test('a temporary folder someone removed is made again, and stale temporary files are cleared', async (t) => {
  const chosen = folder(t)
  const target = new FolderTarget(chosen)
  await target.ready({ create: true })
  fs.rmSync(path.join(chosen, REPO_DIR, 'tmp'), { recursive: true })
  await target.ready()
  t.is(await target.putOnce('objects/cd/two', b4a.from('2')), 'written')
  fs.writeFileSync(path.join(chosen, REPO_DIR, 'tmp', 'stray'), 'x')
  await target.ready({ now: Date.now() + 2 * 60 * 60 * 1000 })
  t.alike(await target.list('tmp'), [])
})

test('a chosen folder that is gone is offline, and nothing is created in its place', async (t) => {
  const parent = folder(t)
  const chosen = path.join(parent, 'unmounted-share')
  const target = new FolderTarget(chosen)
  t.is(await codeOf(target.ready({ create: true })), 'BACKUP_TARGET_OFFLINE')
  t.absent(fs.existsSync(chosen))
})

test('a folder Mirall may not write to is refused as such', async (t) => {
  const chosen = folder(t)
  fs.chmodSync(chosen, 0o500)
  t.is(await codeOf(new FolderTarget(chosen).ready({ create: true })), 'BACKUP_TARGET_DENIED')
})

test('a repository opens only for its identity, its own id, and while its header is there', async (t) => {
  await freshPeer(t)
  const chosen = folder(t)
  const target = new FolderTarget(chosen)
  await target.ready({ create: true })
  const repo = await openOrInitRepo(target, { wrapKey: backupWrapKey() })
  t.is((await openRepo(target, { wrapKey: backupWrapKey(), expectedRepoId: repo.repoId })).repoId, repo.repoId)
  t.is(await codeOf(openRepo(target, { wrapKey: crypto.randomBytes(32), expectedRepoId: repo.repoId })), 'BACKUP_FOREIGN_IDENTITY')
  t.is(await codeOf(openRepo(target, { wrapKey: backupWrapKey(), expectedRepoId: 'f'.repeat(32) })), 'BACKUP_FOREIGN_REPO')
  t.is((await openOrInitRepo(target, { wrapKey: backupWrapKey() })).repoId, repo.repoId, 'a device with no remembered id takes the backup already there')
  t.is(await codeOf(openOrInitRepo(target, { wrapKey: crypto.randomBytes(32) })), 'BACKUP_FOREIGN_IDENTITY', 'unless another identity made it')
  fs.rmSync(path.join(chosen, REPO_DIR, 'mirall-backup.json'))
  t.is(await codeOf(openRepo(target, { wrapKey: backupWrapKey(), expectedRepoId: repo.repoId })), 'BACKUP_TARGET_OFFLINE')
})

test('a run writes sealed objects and a snapshot, and nothing readable', async (t) => {
  const { storage } = await freshPeer(t, { displayName: 'Plaintext Name' })
  const { spaceId } = await createSpace('Plaintext Space')
  await advertise(spaceId, 'share-1', 'plaintext-file.txt', { size: 1, mtime: 1, contentHash: null })
  const chosen = folder(t)
  const target = new FolderTarget(chosen)
  const first = await runBackup({ ...runArgs(target, null), storagePath: storage })
  t.ok(first.repoId)
  t.ok(first.snapshot)
  t.ok(first.parts > 0)
  const all = b4a.toString(b4a.concat(filesUnder(path.join(chosen, REPO_DIR)).map((f) => fs.readFileSync(f))))
  for (const secret of ['Plaintext Name', 'Plaintext Space', 'plaintext-file', '"theme"']) t.absent(all.includes(secret), `"${secret}" is not on the target`)
  t.ok(fs.existsSync(path.join(chosen, REPO_DIR, 'leases', 'install-a.json')))
})

test('an unchanged run writes no snapshot; a change writes one on top of the last', async (t) => {
  const { storage } = await freshPeer(t)
  const target = new FolderTarget(folder(t))
  const first = await runBackup({ ...runArgs(target, null), storagePath: storage })
  const same = await runBackup({ ...runArgs(target, first.repoId), storagePath: storage })
  t.is(same.snapshot, null)
  await setProfile({ displayName: 'Changed' })
  const changed = await runBackup({ ...runArgs(target, first.repoId), storagePath: storage })
  t.ok(changed.snapshot)
  const repo = await openRepo(target, { wrapKey: backupWrapKey(), expectedRepoId: first.repoId })
  t.alike(await repo.listSnapshots(), [changed.snapshot, first.snapshot].sort().reverse())
  t.is((await repo.readSnapshot(changed.snapshot)).parent, first.snapshot)
})

test('another computer writing to the same folder stops the run', async (t) => {
  const { storage } = await freshPeer(t)
  const target = new FolderTarget(folder(t))
  const first = await runBackup({ ...runArgs(target, null), storagePath: storage })
  const repo = await openRepo(target, { wrapKey: backupWrapKey(), expectedRepoId: first.repoId })
  await repo.writeLease('install-b')
  t.is(await codeOf(runBackup({ ...runArgs(target, first.repoId), storagePath: storage })), 'BACKUP_OTHER_DEVICE_WRITING')
  t.is(await codeOf(runBackup({ ...runArgs(target, first.repoId, { now: () => Date.now() + 25 * 60 * 60 * 1000 }), storagePath: storage })), null,
    'a lease a day old no longer counts')
})

test('a first run that stopped part-way is picked up by the next, not refused as another backup', async (t) => {
  const { storage } = await freshPeer(t)
  const target = new FolderTarget(folder(t))
  t.is(await codeOf(runBackup({ ...runArgs(target, null, { stopAt: () => Date.now() - 1 }), storagePath: storage })), 'ECANCELLED')
  const retry = await runBackup({ ...runArgs(target, null), storagePath: storage })
  t.ok(retry.snapshot)
})

test('snapshot order follows the chain, not the clock', async (t) => {
  const { storage } = await freshPeer(t)
  const target = new FolderTarget(folder(t))
  const first = await runBackup({ ...runArgs(target, null), storagePath: storage })
  await setProfile({ displayName: 'Earlier clock' })
  const second = await runBackup({ ...runArgs(target, first.repoId, { now: () => Date.now() - 24 * 60 * 60 * 1000 }), storagePath: storage })
  const repo = await openRepo(target, { wrapKey: backupWrapKey(), expectedRepoId: first.repoId })
  t.is((await repo.latestSnapshot()).name, second.snapshot, 'the newer snapshot is latest though its clock reads a day earlier')
})

test('a backup is never written without an identity to seal it', async (t) => {
  const { storage } = await freshPeer(t)
  const chosen = folder(t)
  t.is(await codeOf(runBackup({ ...runArgs(new FolderTarget(chosen), null, { wrapKey: null }), storagePath: storage })), 'IDENTITY_NO_KEK')
  t.absent(fs.existsSync(path.join(chosen, REPO_DIR)), 'and nothing is created')
})

test('a run out of time writes no snapshot and leaves the last one latest', async (t) => {
  const { storage } = await freshPeer(t)
  const target = new FolderTarget(folder(t))
  const first = await runBackup({ ...runArgs(target, null), storagePath: storage })
  await setProfile({ displayName: 'Late' })
  t.is(await codeOf(runBackup({ ...runArgs(target, first.repoId, { stopAt: () => Date.now() - 1 }), storagePath: storage })), 'ECANCELLED')
  const repo = await openRepo(target, { wrapKey: backupWrapKey(), expectedRepoId: first.repoId })
  t.is((await repo.latestSnapshot()).name, first.snapshot)
})

test('the latest snapshot, read back from the folder, rebuilds every core and the key vault', async (t) => {
  const { storage } = await freshPeer(t, { displayName: 'Round Trip' })
  await createSpace('Kept')
  const target = new FolderTarget(folder(t))
  const first = await runBackup({ ...runArgs(target, null), storagePath: storage })
  await setProfile({ displayName: 'Round Trip 2' })
  await runBackup({ ...runArgs(target, first.repoId), storagePath: storage })

  const repo = await openRepo(target, { wrapKey: backupWrapKey(), expectedRepoId: first.repoId })
  const { manifest } = await repo.latestSnapshot()
  const dir = tmpDir('backup-repo-restore')
  const restored = new Corestore(dir)
  t.teardown(async () => { await restored.close(); try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }, { order: 0 })
  for (const entry of manifest.cores) {
    const core = restored.get({ key: b4a.from(entry.key, 'hex') })
    await core.ready()
    for (const segment of entry.segments) {
      for (const id of segment.parts) for (const record of decodePart(await repo.readPart(id)).records) await applyRecord(core, record)
    }
    t.is(core.length, entry.length, `${entry.role}: length`)
    await core.close()
  }
  const vaultFile = path.join(path.dirname(storage), 'space-keys.enc')
  t.alike(await repo.readPart(manifest.files.spaceKeys), fs.readFileSync(vaultFile), 'the vault file as it was')
  t.alike(await repo.readPart(manifest.files.config), b4a.from('{"theme":"dark"}'))
})
