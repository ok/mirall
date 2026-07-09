import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { validateMountPathSync, validateMountPath, validateDownloadFolder } from '../../src/shared/folders/mount-validate.js'
import { setDownloadFolder, setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
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

test('rejects empty / non-string input', (t) => {
  t.is(codeOf(() => validateMountPathSync('', 'owned-folder', [])), ErrorCodes.NOT_FOUND)
  t.is(codeOf(() => validateMountPathSync(null, 'owned-folder', [])), ErrorCodes.NOT_FOUND)
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

test('rejects a foreign mount inside the download folder', (t) => {
  const downloads = tmpDir(t)
  setDownloadFolder(downloads)
  t.teardown(() => setDownloadFolder(null))
  const inside = path.join(downloads, 'mirror')
  fs.mkdirSync(inside, { recursive: true })
  t.is(codeOf(() => validateMountPathSync(inside, 'foreign-folder', [])), ErrorCodes.MOUNT_INSIDE_DOWNLOADS)
  // ...but the same path is fine for an owned folder (the rule is foreign-only).
  t.ok(validateMountPathSync(inside, 'owned-folder', []).mountPath, 'owned folder inside downloads is allowed')
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
