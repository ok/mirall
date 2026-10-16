import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { validateMountPathSync, validateMountPath, validateDownloadFolderAgainstMounts } from '../../src/shared/folders/mount-validate.js'
import { setDownloadFolder, setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { setSpaceDownloadRoot, hydrateDownloadRoots, setRecentDownloadFolders, noteLandedFolders, setLandedFolders } from '../../src/shared/core/paths.js'
import { createOwnedMount, deleteOwnedMount, initMounts } from '../../src/shared/folders/mount-store.js'
import { recordPending } from '../../src/shared/transfer/pending-transfers.js'
import { markDownloaded } from '../../src/shared/transfer/files.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'
import { freshPeer } from '../helpers/store.js'
import { CODES } from '../../src/shared/contract/errors.js'
import { tmpDir } from '../helpers/bare-tmp.js'

function codeOf(fn) {
  try { fn(); return null } catch (e) { return e.code }
}

async function asyncCodeOf(promise) {
  try { await promise; return null } catch (e) { return e.code }
}

const SYSTEM_PATH = {
  darwin: '/System/Library/x',
  linux: '/proc/x',
  win32: 'C:\\Windows\\x',
}[os.platform()] || '/proc/x'

test('accepts an ordinary writable path', (t) => {
  const dir = tmpDir('mv', t)
  const r = validateMountPathSync(dir, 'owned-folder', [])
  t.ok(typeof r.mountPath === 'string' && r.mountPath.length > 0, 'returns a normalized path')
  t.ok(Array.isArray(r.advisories), 'returns advisories')
})

// REGRESSION (FIX-CODES-2: this was NOT_FOUND, one code shared by 27 throw sites carrying 13
// different meanings, all mapped to the picker's "Choose a folder to share.")
test('REGRESSION (FIX-CODES-2): rejects empty / non-string input with its own code', (t) => {
  t.is(codeOf(() => validateMountPathSync('', 'owned-folder', [])), CODES.MOUNT_PATH_MISSING)
  t.is(codeOf(() => validateMountPathSync(null, 'owned-folder', [])), CODES.MOUNT_PATH_MISSING)
})

test('rejects system folders', (t) => {
  t.is(codeOf(() => validateMountPathSync(SYSTEM_PATH, 'owned-folder', [])), CODES.MOUNT_FORBIDDEN_SYSTEM)
})

test('rejects NESTED overlap with an existing mount (parent/child)', (t) => {
  const parent = tmpDir('mv', t)
  const child = path.join(parent, 'child')
  fs.mkdirSync(child, { recursive: true })
  const existingParent = [{ role: 'owned-folder', shareId: 's1', mountPath: parent }]
  t.is(codeOf(() => validateMountPathSync(child, 'owned-folder', existingParent)), CODES.MOUNT_OVERLAPS, 'child nested in an owned parent is rejected')
  const existingChild = [{ role: 'owned-folder', shareId: 's1', mountPath: child }]
  t.is(codeOf(() => validateMountPathSync(parent, 'owned-folder', existingChild, { shareId: 'other' })), CODES.MOUNT_OVERLAPS, 'a parent that nests an existing owned child is rejected')
})

test('ALLOWS the same exact folder shared as a second owned share (multi-space)', (t) => {
  const dir = tmpDir('mv', t)
  const existing = [{ role: 'owned-folder', shareId: 's1', mountPath: dir }]
  const r = validateMountPathSync(dir, 'owned-folder', existing, { shareId: 's2' })
  t.ok(r.mountPath, 'second owned share at the same path is allowed (owned folders are publish-only)')
})

test('still rejects same-path overlap when a mirror is involved', (t) => {
  const dir = tmpDir('mv', t)
  const withForeign = [{ role: 'foreign-folder', shareId: 'f1', mountPath: dir }]
  t.is(codeOf(() => validateMountPathSync(dir, 'owned-folder', withForeign, { shareId: 's2' })), CODES.MOUNT_OVERLAPS, 'owned source cannot co-locate with a mirror')
  const withOwned = [{ role: 'owned-folder', shareId: 's1', mountPath: dir }]
  t.is(codeOf(() => validateMountPathSync(dir, 'foreign-folder', withOwned, { shareId: 'f2' })), CODES.MOUNT_OVERLAPS, 'mirror cannot co-locate with an owned source')
  t.is(codeOf(() => validateMountPathSync(dir, 'foreign-folder', withForeign, { shareId: 'f2' })), CODES.MOUNT_OVERLAPS, 'two mirrors on one path is rejected')
})

test('revalidating the same mount (same role + shareId) is allowed', (t) => {
  const dir = tmpDir('mv', t)
  const existing = [{ role: 'owned-folder', shareId: 's1', mountPath: dir }]
  const r = validateMountPathSync(dir, 'owned-folder', existing, { shareId: 's1' })
  t.ok(r.mountPath, 'no overlap error when re-pointing the same share')
})

test('rejects any mount inside the download folder', (t) => {
  const downloads = tmpDir('mv', t)
  setDownloadFolder(downloads)
  t.teardown(() => setDownloadFolder(null))
  const inside = path.join(downloads, 'mirror')
  fs.mkdirSync(inside, { recursive: true })
  t.is(codeOf(() => validateMountPathSync(inside, 'foreign-folder', [])), CODES.MOUNT_INSIDE_DOWNLOADS)
  // Owned folders used to be exempt here. They must not be: a watcher on a share that contains
  // a download folder publishes every file downloaded into it to that share's peers.
  t.is(codeOf(() => validateMountPathSync(inside, 'owned-folder', [])), CODES.MOUNT_INSIDE_DOWNLOADS,
    'an owned share inside a download folder is refused too')
})

test('rejects a cloud-sync location outright (both roles)', (t) => {
  const base = tmpDir('mv', t)
  const cloud = path.join(base, 'Dropbox', 'mirror')
  fs.mkdirSync(cloud, { recursive: true })
  t.is(codeOf(() => validateMountPathSync(cloud, 'owned-folder', [])), CODES.MOUNT_FORBIDDEN_CLOUD_SYNC, 'cloud-sync folder is a hard reject, not an advisory')
  t.is(codeOf(() => validateMountPathSync(cloud, 'foreign-folder', [])), CODES.MOUNT_FORBIDDEN_CLOUD_SYNC, 'rejected for mirrors too')
})

test('REGRESSION (FIX-612): a provider name inside an ordinary folder name is accepted (both roles)', (t) => {
  const base = tmpDir('mv', t)
  for (const name of [path.join('megan', 'projects'), 'sandbox', 'Inbox Scans', 'Xbox Clips']) {
    const dir = path.join(base, name)
    fs.mkdirSync(dir, { recursive: true })
    for (const role of ['owned-folder', 'foreign-folder']) {
      t.is(validateMountPathSync(dir, role, []).mountPath, dir, `${name} (${role})`)
    }
  }
})

test('a macOS File Provider folder is rejected as cloud sync, ahead of the ~/Library rule', (t) => {
  if (os.platform() !== 'darwin') { t.pass('darwin-only path'); return }
  const cloud = path.join(os.homedir(), 'Library', 'CloudStorage', 'Dropbox', 'x')
  t.is(codeOf(() => validateMountPathSync(cloud, 'foreign-folder', [])), CODES.MOUNT_FORBIDDEN_CLOUD_SYNC)
  t.is(codeOf(() => validateMountPath(cloud, 'owned-folder', {})), CODES.MOUNT_FORBIDDEN_CLOUD_SYNC)
})

test('an ordinary path carries no advisories', (t) => {
  const dir = tmpDir('mv', t)
  const r = validateMountPathSync(dir, 'owned-folder', [])
  t.is(r.advisories.length, 0, 'no advisories for a plain temp dir')
})

// MIR-10: mounting AT a top-level personal root drops peer content amid the
// user's files and (with the deletion reconcile) hands a peer control over them.
// Both validators must hard-reject the bare roots for BOTH roles; a subfolder
// stays allowed (covered by the personalRootViolation unit test).
test('REGRESSION (MIR-10): both validators reject mounting at a personal root, both roles', (t) => {
  const home = os.homedir()
  const roots = [home, path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads')]
  for (const root of roots) {
    for (const role of ['owned-folder', 'foreign-folder']) {
      t.is(codeOf(() => validateMountPathSync(root, role, [])), CODES.MOUNT_FORBIDDEN_PERSONAL_ROOT, `sync rejects ${root} (${role})`)
      // validateMountPath throws synchronously before its async overlap probe, so
      // codeOf catches it — and asserts the async validator agrees (MIR-21).
      t.is(codeOf(() => validateMountPath(root, role, {})), CODES.MOUNT_FORBIDDEN_PERSONAL_ROOT, `async rejects ${root} (${role})`)
    }
  }
})

// MIR-51: a mirror writes every owner relPath under its root, so a root a login manager or a shell
// runs from (LaunchAgents, autostart, authorized_keys) lets a co-member plant code. Both validators
// must hard-reject those roots and their children for both roles; siblings stay allowed (unit test).
test('REGRESSION (MIR-51): both validators reject a user system root, both roles', (t) => {
  const home = os.homedir()
  const roots = [path.join(home, '.ssh'), path.join(home, '.config', 'autostart')]
  if (os.platform() === 'darwin') roots.push(path.join(home, 'Library', 'LaunchAgents'), path.join(home, 'Library', 'Mail', 'INBOX.mbox'), '/Applications')
  for (const root of roots) {
    for (const role of ['owned-folder', 'foreign-folder']) {
      t.is(codeOf(() => validateMountPathSync(root, role, [])), CODES.MOUNT_FORBIDDEN_SYSTEM, `sync rejects ${root} (${role})`)
      t.is(codeOf(() => validateMountPath(root, role, {})), CODES.MOUNT_FORBIDDEN_SYSTEM, `async rejects ${root} (${role})`)
    }
  }
})

test('iCloud Drive is rejected as cloud sync, ahead of the ~/Library rule', (t) => {
  if (os.platform() !== 'darwin') { t.pass('darwin-only path'); return }
  const icloud = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'x')
  t.is(codeOf(() => validateMountPathSync(icloud, 'foreign-folder', [])), CODES.MOUNT_FORBIDDEN_CLOUD_SYNC)
  t.is(codeOf(() => validateMountPath(icloud, 'foreign-folder', {})), CODES.MOUNT_FORBIDDEN_CLOUD_SYNC)
})

// MIR-21: the two validators had drifted — the async one rejected illegal Windows
// characters + trailing space/dot, the sync one only reserved device names. They
// now share one segment check, so both reject the same illegal names. (win32-only:
// the segment rules don't run on POSIX, where both validators skip them in lockstep.)
test('REGRESSION (MIR-21): both validators reject the same illegal Windows segments', (t) => {
  if (os.platform() !== 'win32') { t.pass('win32-only segment rules; both validators skip identically on POSIX'); return }
  const cases = ['C:\\Users\\me\\NUL', 'C:\\Users\\me\\bad>name', 'C:\\Users\\me\\trailing ']
  for (const p of cases) {
    t.is(codeOf(() => validateMountPathSync(p, 'owned-folder', [])), CODES.MOUNT_FORBIDDEN_WIN_RESERVED, `sync rejects ${p}`)
    t.is(codeOf(() => validateMountPath(p, 'owned-folder', {})), CODES.MOUNT_FORBIDDEN_WIN_RESERVED, `async rejects ${p}`)
  }
})

test('rejects a path that is not writable', (t) => {
  const dir = tmpDir('mv', t)
  fs.chmodSync(dir, 0o500)                       // r-x: the write probe will fail
  t.teardown(() => { try { fs.chmodSync(dir, 0o755) } catch {} })
  t.is(codeOf(() => validateMountPathSync(dir, 'owned-folder', [])), CODES.MOUNT_NOT_WRITABLE)
})

// The shape and writability rules, asserted on the validator the worker actually runs. One booted
// peer: the overlap half of the validator needs the mount store open, and these nine share it.
test('REGRESSION (MIR-34: download-folder shape and writability rules on the shipped validator)', async (t) => {
  await freshPeer(t)
  await initMounts()
  const reject = (folder) => asyncCodeOf(validateDownloadFolderAgainstMounts(folder))

  await t.test('accepts an existing writable dir', async (t) => {
    const dir = tmpDir('mv', t)
    t.is(await validateDownloadFolderAgainstMounts(dir), dir, 'returns the folder on success')
  })
  await t.test('rejects empty / non-string', async (t) => {
    for (const bad of ['', null, undefined, 42]) t.is(await reject(bad), CODES.DOWNLOAD_FOLDER_INVALID, String(bad))
  })
  await t.test('rejects a relative path', async (t) => {
    t.is(await reject('relative/dir'), CODES.DOWNLOAD_FOLDER_INVALID)
  })
  await t.test('rejects a non-existent path', async (t) => {
    t.is(await reject(path.join(tmpDir('mv', t), 'nope')), CODES.DOWNLOAD_FOLDER_INVALID)
  })
  await t.test('rejects a file, not a directory', async (t) => {
    const file = path.join(tmpDir('mv', t), 'a-file')
    fs.writeFileSync(file, 'x')
    t.is(await reject(file), CODES.DOWNLOAD_FOLDER_INVALID)
  })
  await t.test('rejects a non-writable dir', async (t) => {
    const ro = path.join(tmpDir('mv', t), 'readonly')
    fs.mkdirSync(ro)
    fs.chmodSync(ro, 0o500)
    t.teardown(() => { try { fs.chmodSync(ro, 0o700) } catch {} })
    t.is(await reject(ro), CODES.DOWNLOAD_FOLDER_INVALID)
  })
  await t.test('does not create a missing target', async (t) => {
    const missing = path.join(tmpDir('mv', t), 'should-not-be-created')
    await reject(missing)
    let created = false
    try { fs.statSync(missing); created = true } catch {}
    t.absent(created, 'rejecting a missing folder must not create it')
  })
  await t.test('an invalid folder does not mutate the live downloadFolder', async (t) => {
    setRuntimeConfig({ downloadFolder: '/tmp/known-good' })
    await t.exception(validateDownloadFolderAgainstMounts('not/absolute'), /absolute/i)
    t.is(getRuntimeConfig().downloadFolder, '/tmp/known-good', 'rejected input leaves the live config untouched')
  })
  await t.test('a valid folder updates the live downloadFolder', async (t) => {
    setRuntimeConfig({ downloadFolder: '/tmp/known-good' })
    const dir = tmpDir('mv', t)
    setDownloadFolder(await validateDownloadFolderAgainstMounts(dir))
    t.is(getRuntimeConfig().downloadFolder, dir, 'a valid folder is applied')
  })
})

// Per-space download folders mean the "no mirror inside downloads" rule can no longer
// look at a single directory — a mirror inside ANY space's folder is the same hazard.
test('rejects a foreign mount inside a per-space download root', (t) => {
  const globalDl = tmpDir('mv', t)
  const spaceDl = tmpDir('mv', t)
  setDownloadFolder(globalDl)
  hydrateDownloadRoots([{ spaceId: 'space1', downloadFolder: spaceDl }])
  t.teardown(() => { setDownloadFolder(null); hydrateDownloadRoots([]) })

  const inside = path.join(spaceDl, 'mirror')
  fs.mkdirSync(inside, { recursive: true })
  t.is(codeOf(() => validateMountPathSync(inside, 'foreign-folder', [])), CODES.MOUNT_INSIDE_DOWNLOADS,
    'a per-space root is guarded exactly like the global one')
})

// A folder a download went to once and no space downloads into any more may be shared: only the
// folders downloads go to next are guarded.
test('a mount over a recent or landed folder that no space downloads into is allowed', (t) => {
  const current = tmpDir('mv', t)
  const recent = tmpDir('mv', t)
  const landed = tmpDir('mv', t)
  setDownloadFolder(current)
  hydrateDownloadRoots([])
  setRecentDownloadFolders([recent])
  noteLandedFolders([landed])
  t.teardown(() => { setDownloadFolder(null); setRecentDownloadFolders([]); setLandedFolders([]) })

  t.is(codeOf(() => validateMountPathSync(recent, 'owned-folder', [])), null, 'a recent folder')
  t.is(codeOf(() => validateMountPathSync(landed, 'foreign-folder', [])), null, 'a landed folder')
  t.is(codeOf(() => validateMountPathSync(current, 'owned-folder', [])), CODES.MOUNT_INSIDE_DOWNLOADS, 'the current folder still is not')
})

// A download folder overlapping a mount is unsafe both ways: downloads landing inside an
// OWNED folder get auto-published by its watcher, and a mirror inside a download folder
// intermixes a mirrored tree with flat downloads.
test('validateDownloadFolderAgainstMounts rejects overlap with a mount, in both directions', async (t) => {
  const base = tmpDir('mv', t)
  const mount = path.join(base, 'shared')
  const inside = path.join(mount, 'downloads')
  fs.mkdirSync(inside, { recursive: true })

  await freshPeer(t)
  await initMounts()
  await createOwnedMount({ spaceId: 'sp', shareId: 'sh', mountPath: mount })
  t.teardown(() => deleteOwnedMount('sp', 'sh'))

  t.is(await asyncCodeOf(validateDownloadFolderAgainstMounts(inside)), CODES.DOWNLOAD_FOLDER_OVERLAPS_MOUNT,
    'a folder inside an owned mount is refused')
  t.is(await asyncCodeOf(validateDownloadFolderAgainstMounts(base)), CODES.DOWNLOAD_FOLDER_OVERLAPS_MOUNT,
    'a folder containing an owned mount is refused')

  const sibling = path.join(base, 'sharedx')
  fs.mkdirSync(sibling, { recursive: true })
  const ok = await validateDownloadFolderAgainstMounts(sibling)
  t.ok(ok, 'a name-prefix sibling of the mount is fine')
})

// REGRESSION (DL-3): the mount side of the invariant only covered a foreign mount nested
// INSIDE a root. An OWNED share was exempt entirely and containment was one-directional, so
// the hazard the error text describes — "downloads there would be published to your peers" —
// stayed reachable simply by choosing the download folder first and sharing its parent second.
test('rejects an OWNED share that overlaps a download root, in both directions', (t) => {
  const globalDl = tmpDir('mv', t)
  const base = tmpDir('mv', t)
  const spaceDl = path.join(base, 'space-dl')
  fs.mkdirSync(spaceDl, { recursive: true })
  setDownloadFolder(globalDl)
  hydrateDownloadRoots([{ spaceId: 'space1', downloadFolder: spaceDl }])
  t.teardown(() => { setDownloadFolder(null); hydrateDownloadRoots([]) })

  t.is(codeOf(() => validateMountPathSync(base, 'owned-folder', [])), CODES.MOUNT_CONTAINS_DOWNLOADS,
    'sharing a parent of a per-space download root is refused')
  const inside = path.join(spaceDl, 'sub')
  fs.mkdirSync(inside, { recursive: true })
  t.is(codeOf(() => validateMountPathSync(inside, 'owned-folder', [])), CODES.MOUNT_INSIDE_DOWNLOADS,
    'and so is sharing a folder inside one')
  t.is(codeOf(() => validateMountPathSync(path.join(globalDl, 'sub2'), 'foreign-folder', [])), CODES.MOUNT_INSIDE_DOWNLOADS,
    'the global root keeps its own guard')
})

// REGRESSION (DL-4): the write probe ran first, so a folder the very next line REFUSED had a
// probe file created and renamed inside it — inside a watched, published share.
test('a rejected download folder is never written to', async (t) => {
  const mount = tmpDir('mv', t)
  const inside = path.join(mount, 'downloads')
  fs.mkdirSync(inside, { recursive: true })

  await freshPeer(t)
  await initMounts()
  await createOwnedMount({ spaceId: 'sp', shareId: 'sh', mountPath: mount })
  t.teardown(() => deleteOwnedMount('sp', 'sh'))

  t.is(await asyncCodeOf(validateDownloadFolderAgainstMounts(inside)), CODES.DOWNLOAD_FOLDER_OVERLAPS_MOUNT)
  t.alike(fs.readdirSync(inside), [], 'no probe file was created in the refused folder')
})

test('validateDownloadFolderAgainstMounts allows a folder already used by another space', async (t) => {
  const dir = tmpDir('mv', t)
  await freshPeer(t)
  await initMounts()
  setSpaceDownloadRoot('other-space', dir)
  t.teardown(() => hydrateDownloadRoots([]))

  const ok = await validateDownloadFolderAgainstMounts(dir)
  t.is(ok, dir, 'sharing one download folder across spaces is the default state, never an overlap')
})

// REGRESSION (FIX-DLTO-R3: a pending download keeps landing in the folder it started in after its
// space moves on to another one, and only the folders downloads go to next were guarded — so that
// folder, or its parent, could be shared or mirrored, and the file the row then wrote was published.)
test('REGRESSION (FIX-DLTO-R3: a folder a pending download still lands in cannot be mounted)', async (t) => {
  await freshPeer(t)
  const base = tmpDir('mv', t)
  const started = path.join(base, 'In')
  const intent = tmpDir('mv', t)
  const now = tmpDir('mv', t)
  const finished = tmpDir('mv', t)
  fs.mkdirSync(started, { recursive: true })
  await recordPending('s', '/big.bin', { finalPath: path.join(started, 'big.bin'), destDir: started, bytesTransferred: 4096, inPlace: true, shareId: LOOSE_SHARE_ID, relPath: 'big.bin', ownerKey: 'o' })
  await recordPending('s', '/next.bin', { destDir: intent, bytesTransferred: 0, inPlace: true, shareId: LOOSE_SHARE_ID, relPath: 'next.bin', ownerKey: 'o' })
  fs.writeFileSync(path.join(finished, 'done.bin'), 'whole')
  await markDownloaded('s', '/done.bin', path.join(finished, 'done.bin'), { hash: 'h', destDir: finished })
  noteLandedFolders([started, intent, finished])
  hydrateDownloadRoots([{ spaceId: 's', downloadFolder: now }])
  t.teardown(() => hydrateDownloadRoots([]))

  t.is(await asyncCodeOf(validateMountPath(started, 'owned-folder')), CODES.MOUNT_INSIDE_DOWNLOADS, 'the folder a started row lands in')
  t.is(await asyncCodeOf(validateMountPath(base, 'owned-folder')), CODES.MOUNT_CONTAINS_DOWNLOADS, 'and its parent')
  t.is(await asyncCodeOf(validateMountPath(started, 'foreign-folder')), CODES.MOUNT_INSIDE_DOWNLOADS, 'for a mirror too')
  t.is(await asyncCodeOf(validateMountPath(intent, 'owned-folder')), CODES.MOUNT_INSIDE_DOWNLOADS, 'a row that has not started yet lands there too')
  t.is(await asyncCodeOf(validateMountPath(now, 'owned-folder')), CODES.MOUNT_INSIDE_DOWNLOADS, 'the space\'s folder is guarded as before')
  t.is((await validateMountPath(finished, 'owned-folder')).mountPath, finished, 'a folder that only holds finished copies may be shared')
})

// A row whose folder is gone resumes into it again once it is recreated, so the folder it names
// stays guarded while the row exists.
test('a folder a pending download names stays guarded while it is missing', async (t) => {
  await freshPeer(t)
  const base = tmpDir('mv', t)
  const gone = path.join(base, 'In')
  await recordPending('s', '/big.bin', { finalPath: path.join(gone, 'big.bin'), destDir: gone, bytesTransferred: 4096, inPlace: true, shareId: LOOSE_SHARE_ID, relPath: 'big.bin', ownerKey: 'o' })
  t.absent(fs.existsSync(gone), 'precondition: the folder is not there')
  t.is(await asyncCodeOf(validateMountPath(base, 'owned-folder')), CODES.MOUNT_CONTAINS_DOWNLOADS)
})
