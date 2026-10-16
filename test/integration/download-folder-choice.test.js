import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare } from '../helpers/owned.js'
import { createFolderChooser } from '../../src/worker/download-folder-push.js'
import { registerSpaces } from '../../src/worker/ipc/spaces.js'
import { registerFiles } from '../../src/worker/ipc/files.js'
import { getSpace, upsertMember } from '../../src/shared/spaces/space.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { forgetSpaceRecord } from '../../src/shared/spaces/leave-records.js'
import { forgetSpaceDownloadRoot, getDownloadDir, listCurrentDownloadFolders, listDownloadRoots } from '../../src/shared/core/paths.js'
import { getSettings, loadSettings } from '../../src/shared/core/settings-store.js'
import { flushAudit } from '../../src/shared/audit/audit-log.js'
import { queryAudit } from '../../src/shared/audit/audit-query.js'

// The one way a space's download folder changes: validated against every mount, stored on the space,
// and moved to the front of this device's recent folders. Every client then hears what changed.

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const OWNER = 'peer'.padEnd(64, '0')

async function setup(t) {
  const ctx = await setupOwnedShare(t, { name: 'Vault' })
  let published = 0
  const chooseFolder = createFolderChooser({ ipc: ctx.fake.ipc, publishRevealRoots: () => { published++ } })
  registerSpaces(ctx.fake.ipc, { log: quiet, chooseFolder })
  registerFiles(ctx.fake.ipc, { log: quiet, chooseFolder })
  const state = async () => ({
    record: (await getSpace(ctx.spaceId)).downloadFolder,
    live: getDownloadDir(ctx.spaceId),
    recent: getSettings().downloads.recent,
    roots: listDownloadRoots(),
  })
  const pushes = () => ({
    spaces: ctx.fake.emitted('event:state').filter((e) => e.payload?.spaces).length,
    settings: ctx.fake.emitted('event:reconcile').filter((e) => e.payload?.scope?.kind === 'settings').length,
    published,
  })
  const pick = (spaceId, downloadFolder) => ctx.fake.call('space:update', { spaceId, downloadFolder })
  return { ...ctx, state, pushes, pick }
}

async function updatedRows() {
  await flushAudit()
  return (await queryAudit({ kinds: ['space.updated'] })).entries
}

test('a folder inside an owned folder is refused and changes nothing', async (t) => {
  const s = await setup(t)
  const inside = path.join(s.mountPath, 'downloads')
  fs.mkdirSync(inside, { recursive: true })
  const before = await s.state()
  const code = await s.pick(s.spaceId, inside).then(() => null, (err) => err.code)
  t.is(code, 'DOWNLOAD_FOLDER_OVERLAPS_MOUNT')
  t.alike(await s.state(), before)
  t.alike(s.pushes(), { spaces: 0, settings: 0, published: 0 }, 'and nobody is told')
})

test('a valid folder becomes the space\'s and the newest recent one, and every client hears it', async (t) => {
  const s = await setup(t)
  const before = await s.state()
  const chosen = s.tmpDir('dl-chosen')
  const updated = await s.pick(s.spaceId, chosen)
  const after = await s.state()
  t.is(updated.downloadFolder, chosen, 'the answer carries the new folder')
  t.is(after.record, chosen)
  t.is(after.live, chosen)
  t.alike(after.recent, [chosen, ...before.recent])
  t.ok(after.roots.includes(chosen), 'it is a root Reveal may open')
  t.alike(s.pushes(), { spaces: 1, settings: 1, published: 1 })
})

test('choosing a space\'s current folder moves no space, and moves the folder back to the front', async (t) => {
  const s = await setup(t)
  const other = await createSpace('Borealis')
  const a = s.tmpDir('dl-a')
  const b = s.tmpDir('dl-b')
  await s.pick(s.spaceId, a)
  await s.pick(other.spaceId, b)
  t.alike(getSettings().downloads.recent.slice(0, 2), [b, a], 'precondition: another space\'s folder is the newest')
  const length = getSettings().downloads.recent.length
  const spacePushes = s.pushes().spaces

  await s.pick(s.spaceId, a)
  t.is(s.pushes().spaces, spacePushes, 'the space did not move, so the spaces list is not pushed')
  t.is((await getSpace(s.spaceId)).downloadFolder, a)
  t.alike(getSettings().downloads.recent.slice(0, 2), [a, b], 'the folder is the newest recent one again')
  t.is(getSettings().downloads.recent.length, length, 'and listed once')
})

test('a fourth folder drops the oldest recent one', async (t) => {
  const s = await setup(t)
  const folders = ['dl-1', 'dl-2', 'dl-3', 'dl-4'].map((n) => s.tmpDir(n))
  for (const f of folders) await s.pick(s.spaceId, f)
  t.alike(getSettings().downloads.recent, [folders[3], folders[2], folders[1]])
})

test('space:update with a null folder renames and leaves the folder where it is', async (t) => {
  const s = await setup(t)
  const before = await s.state()
  const updated = await s.fake.call('space:update', { spaceId: s.spaceId, name: 'Renamed', downloadFolder: null })
  t.is(updated.name, 'Renamed')
  t.alike(await s.state(), before)
  t.alike(s.pushes(), { spaces: 0, settings: 0, published: 0 })
})

test('REGRESSION (FIX-DLTO-R13: every folder pick was recorded as a rename): only a changed name or icon writes space.updated', async (t) => {
  const s = await setup(t)
  const { name, icon } = await getSpace(s.spaceId)
  await s.pick(s.spaceId, s.tmpDir('dl-new'))
  await s.pick(s.spaceId, getDownloadDir(s.spaceId))
  await s.fake.call('space:update', { spaceId: s.spaceId, name, icon, downloadFolder: s.tmpDir('dl-edit') })
  t.is((await updatedRows()).length, 0, 'a pick, a re-pick and an Edit Space save of the same name rename nothing')

  await s.fake.call('space:update', { spaceId: s.spaceId, name: 'Borealis', icon })
  const rows = await updatedRows()
  t.is(rows.length, 1, 'a rename is one row')
  t.is(rows[0]?.target.name, 'Borealis')
})

test('REGRESSION (FIX-DLTO-R13: the move was announced before the rename): a rename with a new folder pushes the new name', async (t) => {
  const s = await setup(t)
  const chosen = s.tmpDir('dl-renamed')
  const updated = await s.fake.call('space:update', { spaceId: s.spaceId, name: 'Borealis', downloadFolder: chosen })
  const pushed = s.fake.emitted('event:state').map((e) => e.payload.spaces.find((x) => x.spaceId === s.spaceId))
  t.is(pushed.length, 1, 'one announcement')
  t.alike({ name: pushed[0]?.name, downloadFolder: pushed[0]?.downloadFolder }, { name: 'Borealis', downloadFolder: chosen })
  t.alike({ name: updated.name, downloadFolder: updated.downloadFolder }, { name: 'Borealis', downloadFolder: chosen }, 'and the answer carries both')
})

test('REGRESSION (FIX-DLTO-R22: a folder named for a space that is gone became a download root): nothing is installed', async (t) => {
  const s = await setup(t)
  await forgetSpaceRecord(s.spaceId)
  forgetSpaceDownloadRoot(s.spaceId)
  const recent = getSettings().downloads.recent
  const chosen = s.tmpDir('dl-left')

  const code = await s.fake.call('files:download-many', { spaceId: s.spaceId, ownerKey: OWNER, paths: ['/a.bin'], destDir: chosen }).then(() => null, (err) => err.code)
  t.is(code, 'SPACE_NOT_FOUND', 'a download naming a folder is refused')
  t.is(await s.pick(s.spaceId, chosen), null, 'a pick updates nothing')
  t.absent(listCurrentDownloadFolders().includes(chosen), 'no download goes there')
  t.absent(listDownloadRoots().includes(chosen), 'and Reveal may not open it')
  t.alike(getSettings().downloads.recent, recent, 'the recent folders are as they were')
  t.is(s.pushes().spaces, 0)
})

test('REGRESSION (FIX-DLTO-R5: an unwritable settings.json failed the pick and hid the move): the space moves and says so', async (t) => {
  const s = await setup(t)
  const home = path.dirname(s.storage)
  const recent = getSettings().downloads.recent
  const chosen = s.tmpDir('dl-locked')
  fs.chmodSync(home, 0o555)
  t.teardown(() => fs.chmodSync(home, 0o755))
  const updated = await s.pick(s.spaceId, chosen).catch((err) => err)
  fs.chmodSync(home, 0o755)
  t.is(updated?.downloadFolder, chosen, 'the pick succeeds')
  t.is(getDownloadDir(s.spaceId), chosen)
  t.alike(getSettings().downloads.recent, recent, 'the recent list could not be saved and is as it was')
  t.alike(s.pushes(), { spaces: 1, settings: 0, published: 1 }, 'every client hears the space moved')
})

test('REGRESSION (FIX-DLTO-R5: every download naming a folder rewrote settings.json): a batch into the current, newest folder writes nothing', async (t) => {
  const s = await setup(t)
  await upsertMember(s.spaceId, { publicKey: OWNER }, { verified: true })
  const current = getDownloadDir(s.spaceId)
  t.is(getSettings().downloads.recent[0], current, 'precondition: the current folder is the newest recent one')
  // The same settings laid out as no write of the store's would be, an hour old.
  const file = path.join(path.dirname(s.storage), 'settings.json')
  fs.writeFileSync(file, JSON.stringify(getSettings()))
  const past = new Date(Date.now() - 3600 * 1000)
  fs.utimesSync(file, past, past)
  const disk = () => ({ bytes: fs.readFileSync(file, 'utf-8'), mtimeMs: fs.statSync(file).mtimeMs })
  const before = disk()

  await s.fake.call('files:download-many', { spaceId: s.spaceId, ownerKey: OWNER, paths: ['/a.bin'], destDir: current })
  t.alike(disk(), before)
  t.alike(s.pushes(), { spaces: 0, settings: 0, published: 0 }, 'and nothing is announced')
})

test('a download naming a folder while settings.json is broken leaves the file to the user', async (t) => {
  const s = await setup(t)
  await upsertMember(s.spaceId, { publicKey: OWNER }, { verified: true })
  const file = path.join(path.dirname(s.storage), 'settings.json')
  fs.writeFileSync(file, '{"version":1,"network":{"uploadKBps":12,}}')
  const broken = fs.readFileSync(file, 'utf-8')
  await loadSettings(s.storage)
  const chosen = s.tmpDir('dl-while-broken')

  const res = await s.fake.call('files:download-many', { spaceId: s.spaceId, ownerKey: OWNER, paths: ['/a.bin'], destDir: chosen })
  t.is(res.folderChanged, true, 'the space moves')
  t.is(getSettings().downloads.recent[0], chosen, 'the recent list follows in memory')
  t.is(fs.readFileSync(file, 'utf-8'), broken, 'and the file is still the user\'s to repair')
})
