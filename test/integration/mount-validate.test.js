import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { validateMountPathSync, validateMountPath, validateDownloadFolder, validateDownloadFolderAgainstMounts } from '../../src/shared/folders/mount-validate.js'
import { setDownloadFolder, setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { setSpaceDownloadRoot, hydrateDownloadRoots } from '../../src/shared/core/paths.js'
import { createOwnedMount, deleteOwnedMount, initMounts } from '../../src/shared/folders/mount-store.js'
import { freshPeer } from '../helpers/store.js'
import { ErrorCodes } from '../../src/shared/core/errors.js'

function tmpDir (t) {
  const d = path.join(os.tmpdir(), 'mv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
  fs.mkdirSync(d, { recursive: true })
  if (t) t.teardown(() => { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} })
  return d
}

function codeOf (fn) {
  try { fn(); return null } catch (e) { return e.code }
}

async function asyncCodeOf (promise) {
  try { await promise; return null } catch (e) { return e.code }
}

const SYSTEM_PATH = {
  darwin: '/System/Library/x',
  linux: '/proc/x',
  win32: 'C:\\Windows\\x',
}[os.platform()] || '/proc/x'

test('accepts an ordinary writable path', (t) => {
  const dir = tmpDir(t)
  const r = validateMountPathSync(dir, 'owned-folder', [])
  t.ok(typeof r.mountPath === 'string' && r.mountPath.length > 0, 'returns a normalized path')
  t.ok(Array.isArray(r.advisories), 'returns advisories')
})

// REGRESSION (FIX-CODES-2: this was NOT_FOUND, one code shared by 27 throw sites carrying 13
// different meanings, all mapped to the picker's "Choose a folder to share.")
test('REGRESSION (FIX-CODES-2): rejects empty / non-string input with its own code', (t) => {
  t.is(codeOf(() => validateMountPathSync('', 'owned-folder', [])), ErrorCodes.MOUNT_PATH_MISSING)
  t.is(codeOf(() => validateMountPathSync(null, 'owned-folder', [])), ErrorCodes.MOUNT_PATH_MISSING)
})

test('rejects system folders', (t) => {
  t.is(codeOf(() => validateMountPathSync(SYSTEM_PATH, 'owned-folder', [])), ErrorCodes.MOUNT_FORBIDDEN_SYSTEM)
})

test('rejects NESTED overlap with an existing mount (parent/child)', (t) => {
  const parent = tmpDir(t)
  const child = path.join(parent, 'child')
  fs.mkdirSync(child, { recursive: true })
  const existingParent = [{ role: 'owned-folder', shareId: 's1', mountPath: parent }]
  t.is(codeOf(() => validateMountPathSync(child, 'owned-folder', existingParent)), ErrorCodes.MOUNT_OVERLAPS, 'child nested in an owned parent is rejected')
  const existingChild = [{ role: 'owned-folder', shareId: 's1', mountPath: child }]
  t.is(codeOf(() => validateMountPathSync(parent, 'owned-folder', existingChild, { shareId: 'other' })), ErrorCodes.MOUNT_OVERLAPS, 'a parent that nests an existing owned child is rejected')
})

test('ALLOWS the same exact folder shared as a second owned share (multi-space)', (t) => {
  const dir = tmpDir(t)
  const existing = [{ role: 'owned-folder', shareId: 's1', mountPath: dir }]
  const r = validateMountPathSync(dir, 'owned-folder', existing, { shareId: 's2' })
  t.ok(r.mountPath, 'second owned share at the same path is allowed (owned folders are publish-only)')
})

test('still rejects same-path overlap when a mirror is involved', (t) => {
  const dir = tmpDir(t)
  const withForeign = [{ role: 'foreign-folder', shareId: 'f1', mountPath: dir }]
  t.is(codeOf(() => validateMountPathSync(dir, 'owned-folder', withForeign, { shareId: 's2' })), ErrorCodes.MOUNT_OVERLAPS, 'owned source cannot co-locate with a mirror')
  const withOwned = [{ role: 'owned-folder', shareId: 's1', mountPath: dir }]
  t.is(codeOf(() => validateMountPathSync(dir, 'foreign-folder', withOwned, { shareId: 'f2' })), ErrorCodes.MOUNT_OVERLAPS, 'mirror cannot co-locate with an owned source')
  t.is(codeOf(() => validateMountPathSync(dir, 'foreign-folder', withForeign, { shareId: 'f2' })), ErrorCodes.MOUNT_OVERLAPS, 'two mirrors on one path is rejected')
})

test('revalidating the same mount (same role + shareId) is allowed', (t) => {
  const dir = tmpDir(t)
  const existing = [{ role: 'owned-folder', shareId: 's1', mountPath: dir }]
  const r = validateMountPathSync(dir, 'owned-folder', existing, { shareId: 's1' })
  t.ok(r.mountPath, 'no overlap error when re-pointing the same share')
})

test('rejects any mount inside the download folder', (t) => {
  const downloads = tmpDir(t)
  setDownloadFolder(downloads)
  t.teardown(() => setDownloadFolder(null))
  const inside = path.join(downloads, 'mirror')
  fs.mkdirSync(inside, { recursive: true })
  t.is(codeOf(() => validateMountPathSync(inside, 'foreign-folder', [])), ErrorCodes.MOUNT_INSIDE_DOWNLOADS)
  // Owned folders used to be exempt here. They must not be: a watcher on a share that contains
  // a download folder publishes every file downloaded into it to that share's peers.
  t.is(codeOf(() => validateMountPathSync(inside, 'owned-folder', [])), ErrorCodes.MOUNT_INSIDE_DOWNLOADS,
    'an owned share inside a download folder is refused too')
})

test('rejects a cloud-sync location outright (both roles)', (t) => {
  const base = tmpDir(t)
  const cloud = path.join(base, 'Dropbox', 'mirror')
  fs.mkdirSync(cloud, { recursive: true })
  t.is(codeOf(() => validateMountPathSync(cloud, 'owned-folder', [])), ErrorCodes.MOUNT_FORBIDDEN_CLOUD_SYNC, 'cloud-sync folder is a hard reject, not an advisory')
  t.is(codeOf(() => validateMountPathSync(cloud, 'foreign-folder', [])), ErrorCodes.MOUNT_FORBIDDEN_CLOUD_SYNC, 'rejected for mirrors too')
})

test('an ordinary path carries no advisories', (t) => {
  const dir = tmpDir(t)
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
      t.is(codeOf(() => validateMountPathSync(root, role, [])), ErrorCodes.MOUNT_FORBIDDEN_PERSONAL_ROOT, `sync rejects ${root} (${role})`)
      // validateMountPath throws synchronously before its async overlap probe, so
      // codeOf catches it — and asserts the async validator agrees (MIR-21).
      t.is(codeOf(() => validateMountPath(root, role, {})), ErrorCodes.MOUNT_FORBIDDEN_PERSONAL_ROOT, `async rejects ${root} (${role})`)
    }
  }
})

// MIR-21: the two validators had drifted — the async one rejected illegal Windows
// characters + trailing space/dot, the sync one only reserved device names. They
// now share one segment check, so both reject the same illegal names. (win32-only:
// the segment rules don't run on POSIX, where both validators skip them in lockstep.)
test('REGRESSION (MIR-21): both validators reject the same illegal Windows segments', (t) => {
  if (os.platform() !== 'win32') { t.pass('win32-only segment rules; both validators skip identically on POSIX'); return }
  const cases = ['C:\\Users\\me\\NUL', 'C:\\Users\\me\\bad>name', 'C:\\Users\\me\\trailing ']
  for (const p of cases) {
    t.is(codeOf(() => validateMountPathSync(p, 'owned-folder', [])), ErrorCodes.MOUNT_FORBIDDEN_WIN_RESERVED, `sync rejects ${p}`)
    t.is(codeOf(() => validateMountPath(p, 'owned-folder', {})), ErrorCodes.MOUNT_FORBIDDEN_WIN_RESERVED, `async rejects ${p}`)
  }
})

test('rejects a path that is not writable', (t) => {
  const dir = tmpDir(t)
  fs.chmodSync(dir, 0o500)                       // r-x: the write probe will fail
  t.teardown(() => { try { fs.chmodSync(dir, 0o755) } catch {} })
  t.is(codeOf(() => validateMountPathSync(dir, 'owned-folder', [])), ErrorCodes.MOUNT_NOT_WRITABLE)
})

test('REGRESSION (MIR-34: validateDownloadFolder accepts an existing writable dir)', (t) => {
  const dir = tmpDir(t)
  t.is(validateDownloadFolder(dir), dir, 'returns the folder on success')
})

test('REGRESSION (MIR-34: validateDownloadFolder rejects empty / non-string)', (t) => {
  t.is(codeOf(() => validateDownloadFolder('')), ErrorCodes.DOWNLOAD_FOLDER_INVALID)
  t.is(codeOf(() => validateDownloadFolder(null)), ErrorCodes.DOWNLOAD_FOLDER_INVALID)
  t.is(codeOf(() => validateDownloadFolder(undefined)), ErrorCodes.DOWNLOAD_FOLDER_INVALID)
  t.is(codeOf(() => validateDownloadFolder(42)), ErrorCodes.DOWNLOAD_FOLDER_INVALID)
})

test('REGRESSION (MIR-34: validateDownloadFolder rejects a relative path)', (t) => {
  t.is(codeOf(() => validateDownloadFolder('relative/dir')), ErrorCodes.DOWNLOAD_FOLDER_INVALID)
})

test('REGRESSION (MIR-34: validateDownloadFolder rejects a non-existent path)', (t) => {
  const dir = tmpDir(t)
  t.is(codeOf(() => validateDownloadFolder(path.join(dir, 'nope'))), ErrorCodes.DOWNLOAD_FOLDER_INVALID)
})

test('REGRESSION (MIR-34: validateDownloadFolder rejects a file, not a directory)', (t) => {
  const dir = tmpDir(t)
  const file = path.join(dir, 'a-file')
  fs.writeFileSync(file, 'x')
  t.is(codeOf(() => validateDownloadFolder(file)), ErrorCodes.DOWNLOAD_FOLDER_INVALID)
})

test('REGRESSION (MIR-34: validateDownloadFolder rejects a non-writable dir)', (t) => {
  const dir = tmpDir(t)
  const ro = path.join(dir, 'readonly')
  fs.mkdirSync(ro)
  fs.chmodSync(ro, 0o500)
  t.teardown(() => { try { fs.chmodSync(ro, 0o700) } catch {} })
  t.is(codeOf(() => validateDownloadFolder(ro)), ErrorCodes.DOWNLOAD_FOLDER_INVALID)
})

test('REGRESSION (MIR-34: validateDownloadFolder does not create a missing target)', (t) => {
  const dir = tmpDir(t)
  const missing = path.join(dir, 'should-not-be-created')
  try { validateDownloadFolder(missing) } catch {}
  let created = false
  try { fs.statSync(missing); created = true } catch {}
  t.absent(created, 'rejecting a missing folder must not create it')
})

test('REGRESSION (MIR-34: invalid folder does not mutate the live downloadFolder)', (t) => {
  setRuntimeConfig({ downloadFolder: '/tmp/known-good' })
  t.exception(() => { const f = validateDownloadFolder('not/absolute'); setDownloadFolder(f) }, /absolute/i)
  t.is(getRuntimeConfig().downloadFolder, '/tmp/known-good', 'rejected input leaves the live config untouched')
})

test('REGRESSION (MIR-34: valid folder updates the live downloadFolder)', (t) => {
  setRuntimeConfig({ downloadFolder: '/tmp/known-good' })
  const dir = tmpDir(t)
  setDownloadFolder(validateDownloadFolder(dir))
  t.is(getRuntimeConfig().downloadFolder, dir, 'a valid folder is applied')
})

// Per-space download folders mean the "no mirror inside downloads" rule can no longer
// look at a single directory — a mirror inside ANY space's folder is the same hazard.
test('rejects a foreign mount inside a per-space download root', (t) => {
  const globalDl = tmpDir(t)
  const spaceDl = tmpDir(t)
  setDownloadFolder(globalDl)
  hydrateDownloadRoots([{ spaceId: 'space1', downloadFolder: spaceDl }])
  t.teardown(() => { setDownloadFolder(null); hydrateDownloadRoots([]) })

  const inside = path.join(spaceDl, 'mirror')
  fs.mkdirSync(inside, { recursive: true })
  t.is(codeOf(() => validateMountPathSync(inside, 'foreign-folder', [])), ErrorCodes.MOUNT_INSIDE_DOWNLOADS,
    'a per-space root is guarded exactly like the global one')
})

// A download folder overlapping a mount is unsafe both ways: downloads landing inside an
// OWNED folder get auto-published by its watcher, and a mirror inside a download folder
// intermixes a mirrored tree with flat downloads.
test('validateDownloadFolderAgainstMounts rejects overlap with a mount, in both directions', async (t) => {
  const base = tmpDir(t)
  const mount = path.join(base, 'shared')
  const inside = path.join(mount, 'downloads')
  fs.mkdirSync(inside, { recursive: true })

  await freshPeer(t)
  await initMounts()
  await createOwnedMount({ spaceId: 'sp', shareId: 'sh', mountPath: mount })
  t.teardown(() => deleteOwnedMount('sp', 'sh'))

  t.is(await asyncCodeOf(validateDownloadFolderAgainstMounts(inside)), ErrorCodes.DOWNLOAD_FOLDER_OVERLAPS_MOUNT,
    'a folder inside an owned mount is refused')
  t.is(await asyncCodeOf(validateDownloadFolderAgainstMounts(base)), ErrorCodes.DOWNLOAD_FOLDER_OVERLAPS_MOUNT,
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
  const globalDl = tmpDir(t)
  const base = tmpDir(t)
  const spaceDl = path.join(base, 'space-dl')
  fs.mkdirSync(spaceDl, { recursive: true })
  setDownloadFolder(globalDl)
  hydrateDownloadRoots([{ spaceId: 'space1', downloadFolder: spaceDl }])
  t.teardown(() => { setDownloadFolder(null); hydrateDownloadRoots([]) })

  t.is(codeOf(() => validateMountPathSync(base, 'owned-folder', [])), ErrorCodes.MOUNT_CONTAINS_DOWNLOADS,
    'sharing a parent of a per-space download root is refused')
  const inside = path.join(spaceDl, 'sub')
  fs.mkdirSync(inside, { recursive: true })
  t.is(codeOf(() => validateMountPathSync(inside, 'owned-folder', [])), ErrorCodes.MOUNT_INSIDE_DOWNLOADS,
    'and so is sharing a folder inside one')
  t.is(codeOf(() => validateMountPathSync(path.join(globalDl, 'sub2'), 'foreign-folder', [])), ErrorCodes.MOUNT_INSIDE_DOWNLOADS,
    'the global root keeps its own guard')
})

// REGRESSION (DL-4): the write probe ran first, so a folder the very next line REFUSED had a
// probe file created and renamed inside it — inside a watched, published share.
test('a rejected download folder is never written to', async (t) => {
  const mount = tmpDir(t)
  const inside = path.join(mount, 'downloads')
  fs.mkdirSync(inside, { recursive: true })

  await freshPeer(t)
  await initMounts()
  await createOwnedMount({ spaceId: 'sp', shareId: 'sh', mountPath: mount })
  t.teardown(() => deleteOwnedMount('sp', 'sh'))

  t.is(await asyncCodeOf(validateDownloadFolderAgainstMounts(inside)), ErrorCodes.DOWNLOAD_FOLDER_OVERLAPS_MOUNT)
  t.alike(fs.readdirSync(inside), [], 'no probe file was created in the refused folder')
})

test('validateDownloadFolderAgainstMounts allows a folder already used by another space', async (t) => {
  const dir = tmpDir(t)
  await freshPeer(t)
  await initMounts()
  setSpaceDownloadRoot('other-space', dir)
  t.teardown(() => hydrateDownloadRoots([]))

  const ok = await validateDownloadFolderAgainstMounts(dir)
  t.is(ok, dir, 'sharing one download folder across spaces is the default state, never an overlap')
})
