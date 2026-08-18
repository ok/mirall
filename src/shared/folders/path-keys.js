// Pure path / share-key / prefix / predicate helpers — the single source of truth
// for the path math behind sharing, subfolders, moves, copies and deletes.
//
// This module pulls in NO `bare-*` and no storage, and imports only modules that
// hold to the same rule. `bare-path`/`bare-fs`/`bare-os` don't load under plain
// Node, so anything that imports them can only be tested under Bare
// (`test/integration`). By staying free of them this logic loads under both runtimes
// and is unit-tested directly under Node (`test/unit/path-keys.test.js`). The heavy
// data-layer modules import from here so the platform-divergent string math lives in
// exactly one place.
//
// Functions that need a path separator take it as an argument; callers pass their
// real `path.sep`, tests pass an explicit `/` or `\` to exercise both platforms on
// one machine.
import { PARTIAL_SUFFIX } from '../transfer/partial-suffix.js'

// ─── share key ⇄ OS-relative path ─────────────────────────────────────────────
// Drive keys are always POSIX-style ('/'-joined). On Windows the on-disk relative
// path uses '\'; this is the conversion that every nested (subfolder) file crosses
// twice — once on publish (rel → key) and once on materialize (key → rel).
export function relToDriveKey (relPath, sep) {
  return relPath.split(sep).join('/')
}

export function driveKeyToSegments (key) {
  return key.split('/')
}

// ─── Windows long-path prefix ─────────────────────────────────────────────────
// Strip a Windows extended-length / device prefix so two paths can be compared in
// one namespace. Under Bare on Windows, `fs.readdir(root, { recursive: true })`
// can hand back a `parentPath` carrying a `\\?\E:\…` prefix even when the scan
// root has none; `path.relative` then sees two different roots (`E:\` vs `\\?\E:\`)
// and returns the absolute target verbatim — which would leak an absolute
// `//?/E:/…` path into a drive key (keys must always stay share-relative and
// '/'-separated). Normalizing both sides through this before `path.relative`
// keeps the key relative. POSIX paths and any string without the prefix pass
// through untouched.
export function stripLongPathPrefix (p) {
  if (typeof p !== 'string') return p
  if (p.startsWith('\\\\?\\UNC\\')) return '\\\\' + p.slice('\\\\?\\UNC\\'.length) // \\?\UNC\srv\sh → \\srv\sh
  if (p.startsWith('\\\\?\\')) return p.slice('\\\\?\\'.length)                    // \\?\E:\x → E:\x
  return p
}

// The drive-key invariant: a key is a forward-slash path RELATIVE to the share —
// never an absolute OS path. Returns true (i.e. "reject") for an empty key, a
// leading '/' or '\' (POSIX root / UNC / stray prefix), or a `X:` drive letter.
// Last line of defence so a `\\?\`-prefix mismatch (see `stripLongPathPrefix`) can
// never publish an absolute path as a key. A clean key like `sub/a.txt` is safe.
export function isAbsoluteDriveKey (key) {
  if (typeof key !== 'string' || key === '') return true
  if (key.startsWith('/') || key.startsWith('\\')) return true
  if (/^[a-zA-Z]:/.test(key)) return true
  return false
}

// A materialized rel-path must stay INSIDE its mount. `driveKeyToSegments` splits
// only on '/', so `path.join(mountPath, ...segments)` would climb out on a '..'
// segment — or on a backslash-encoded '..\..' that, split on '/', arrives as one
// segment and slips a naive startsWith('..') check. Hyperdrive normalizes keys at
// PUT time, but a malicious peer can write a raw entry that bypasses that and
// list() serves it verbatim, so the consuming side re-validates here. Returns true
// when the key is unsafe and must be rejected; callers raise AppError (this module
// stays import-free, see the header). A POSIX file literally named with a '\' is
// rejected too — vanishingly rare, and worth far less than blocking traversal.
export function relKeyEscapes (relPath) {
  if (isAbsoluteDriveKey(relPath)) return true
  for (const seg of relPath.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return true
    if (seg.includes('\\')) return true
  }
  return false
}

// ─── share prefix + membership ────────────────────────────────────────────────
export function sharePrefix (name) {
  return '/' + name + '/'
}

export function isInsideShare (key, prefix) {
  return key.startsWith(prefix)
}

export function isInsideAnyShare (key, sharePrefixes) {
  for (const prefix of sharePrefixes) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

// Strip the share prefix to get the in-share relative path (subfolders preserved).
export function relPathInShare (key, prefix) {
  return key.slice(prefix.length)
}

// ─── containment / mount overlap ──────────────────────────────────────────────
// True when `child` is `parent` or sits inside it. The separator boundary prevents
// the classic false positive: `/a/bc` is not inside `/a/b`. `fold` compares
// case-insensitively, for the filesystems that case-fold (darwin/win32).
export function pathContains (parent, child, sep, fold = false) {
  if (!parent || !child) return false
  let root = fold ? parent.toLowerCase() : parent
  while (root.length > 1 && root.endsWith(sep)) root = root.slice(0, -1)
  const c = fold ? child.toLowerCase() : child
  if (c === root) return true
  // A filesystem root ("/", "C:\") already ends in the separator; appending a second
  // one would make every child miss.
  return c.startsWith(root.endsWith(sep) ? root : root + sep)
}

// True when one path is the other, or one is an ancestor of the other. `fold` is passed
// through to pathContains for the filesystems that case-fold (darwin/win32).
export function pathsOverlap (a, b, sep, fold = false) {
  return pathContains(a, b, sep, fold) || pathContains(b, a, sep, fold)
}

// `pathsOverlap` reports raw geometry; this is the policy on top of it. An
// exactly-equal path is permitted between two owned (publish-only) folders, so one
// source tree can be shared into multiple spaces. Every other overlap stays
// rejected: nesting (a parent scan would absorb the child share's tree) and any
// overlap touching a foreign-folder (mirrors write to disk, so co-locating with an
// owned source feedback-loops and two mirrors on one path double-write).
export function overlapAllowed (aPath, aRole, bPath, bRole) {
  return aPath === bPath && aRole === 'owned-folder' && bRole === 'owned-folder'
}

// ─── ignore globs ─────────────────────────────────────────────────────────────
export const DEFAULT_IGNORE = ['.DS_Store', 'Thumbs.db', '*' + PARTIAL_SUFFIX, '*~', '.git/**', 'node_modules/**']

export function shouldIgnore (rel, ignorePatterns) {
  if (!ignorePatterns || ignorePatterns.length === 0) return false
  const base = rel.split('/').pop() ?? rel
  for (const pat of ignorePatterns) {
    if (matchPattern(rel, pat)) return true
    if (matchPattern(base, pat)) return true
  }
  return false
}

function matchPattern (input, pattern) {
  if (pattern === input) return true
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3)
    return input === prefix || input.startsWith(prefix + '/')
  }
  if (pattern.startsWith('*')) {
    return input.endsWith(pattern.slice(1))
  }
  if (pattern.endsWith('*')) {
    return input.startsWith(pattern.slice(0, -1))
  }
  return false
}

// ─── mirror deletion safety ───────────────────────────────────────────────────
// Deletions are propagated to a mirror ONLY when the owner is online (the listing is live), the
// listing is non-empty (an all-empty listing is treated as a transient replication gap, never
// "owner deleted everything"), AND the listing was read to completion. A catalog drain that timed
// out mid-tree returns a PARTIAL, non-empty list — indistinguishable from a real deletion unless
// completeness is checked, and acting on it deletes files the owner still has. The likelihood of
// such a drain grows with the file count, so the bigger the folder, the likelier the wrong delete.
export function shouldHonorDeletions ({ ownerOnline, driveCount, listingComplete }) {
  return !!ownerOnline && driveCount > 0 && !!listingComplete
}

// ─── collision-free download/copy naming ──────────────────────────────────────
// Split a basename into { base, ext } the way `path.extname` does for a leaf name:
// extension is the substring from the last dot, except a leading dot (dotfile) or
// no dot yields no extension. 'a.tar.gz' → ext '.gz'; 'LICENSE'/'.bashrc' → ext ''.
export function splitFileName (fileName) {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return { base: fileName, ext: '' }
  return { base: fileName.slice(0, dot), ext: fileName.slice(dot) }
}

// Pick a name that `isTaken` reports free, suffixing " (1)", " (2)", … before the
// extension. `isTaken(name)` is supplied by the caller (it checks the filesystem
// for both the final file and an in-flight partial).
export function nextFreeName (fileName, isTaken) {
  if (!isTaken(fileName)) return fileName
  const { base, ext } = splitFileName(fileName)
  let n = 1
  let candidate
  do {
    candidate = `${base} (${n})${ext}`
    n++
  } while (isTaken(candidate))
  return candidate
}

// ─── mount path rejection rules ───────────────────────────────────────────────
export const SYSTEM_FOLDERS = {
  darwin: ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/private/var'],
  win32: ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'],
  linux: ['/proc', '/sys', '/dev', '/etc', '/boot', '/var/lib'],
}

export const WIN_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

// Returns the offending system root (for the error message) or null.
export function systemRootViolation (normalized, platform, sep) {
  const roots = SYSTEM_FOLDERS[platform] || []
  for (const root of roots) {
    if (normalized === root || normalized.startsWith(root + sep)) return root
  }
  return null
}

// Top-level personal roots that must never be a mount root themselves: a fresh
// SUBFOLDER under them is fine and common, but mounting AT the root drops peer
// content amid the user's own files. Equality only — never a prefix test — so a
// subfolder stays allowed. `ci` lower-cases on case-insensitive filesystems
// (darwin/win32) so a hand-typed `~/documents` still matches the real root.
export function personalRootViolation (normalized, home, sep, ci = false) {
  if (!home) return null
  const norm = ci ? normalized.toLowerCase() : normalized
  for (const root of [home, home + sep + 'Desktop', home + sep + 'Documents', home + sep + 'Downloads']) {
    if (norm === (ci ? root.toLowerCase() : root)) return root
  }
  return null
}

// A segment is reserved when its name before the first dot is a Windows device name.
export function isWindowsReservedName (segment) {
  return WIN_RESERVED.has(segment.split('.')[0].toUpperCase())
}

// Returns the first path segment that is a reserved Windows device name, or null.
export function firstWinReservedSegment (normalized, sep) {
  for (const seg of normalized.split(sep)) {
    if (!seg) continue
    if (isWindowsReservedName(seg)) return seg
  }
  return null
}

const CLOUD_HINTS = ['dropbox', 'onedrive', 'google drive', 'icloud', 'box', 'nextcloud', 'mega', 'proton drive', 'pcloud']

// Returns the matched cloud-sync provider hint (lower-case) if the path looks like
// it sits inside a cloud-sync folder, else null.
export function cloudSyncHint (lowerPath) {
  for (const hint of CLOUD_HINTS) {
    if (lowerPath.includes(hint)) return hint
  }
  return null
}
