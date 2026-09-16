// Pure path / share-key / prefix / predicate helpers — the single source of truth
// for the path math behind sharing, subfolders, moves, copies and deletes. The heavy
// data-layer modules import from here so the platform-divergent string math lives in
// exactly one place.
//
// Functions that need a path separator take it as an argument; callers pass their
// real `path.sep`, tests pass an explicit `/` or `\` to exercise both platforms on
// one machine.
import ignore, { isPathValid } from 'ignore'
import { PARTIAL_SUFFIX, pathContains } from '../contract/paths.js'

// ─── share key ⇄ OS-relative path ─────────────────────────────────────────────
// Drive keys are always POSIX-style ('/'-joined). On Windows the on-disk relative
// path uses '\'; this is the conversion that every nested (subfolder) file crosses
// twice — once on publish (rel → key) and once on materialize (key → rel).
export function relToDriveKey(relPath, sep) {
  return relPath.split(sep).join('/')
}

export function driveKeyToSegments(key) {
  return key.split('/')
}

// Leaf name of a drive key or drive path. Distinct from `path.basename`, which
// also honours the platform separator: a drive key is POSIX-shaped on every
// platform, so a Windows `\` inside one is part of the name, not a separator.
export function driveBaseName(key) {
  if (typeof key !== 'string') return ''
  return key.slice(key.lastIndexOf('/') + 1)
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
export function stripLongPathPrefix(p) {
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
export function isAbsoluteDriveKey(key) {
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
// carries no error type of its own). A POSIX file literally named with a '\' is
// rejected too — vanishingly rare, and worth far less than blocking traversal.
export function relKeyEscapes(relPath) {
  if (isAbsoluteDriveKey(relPath)) return true
  for (const seg of relPath.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return true
    if (seg.includes('\\')) return true
  }
  return false
}

// Drop poisoned peer entries at ingest so they never reach a materialize batch or a synced
// record — one bad key must not abort a tick or DoS a mirror. `onDropped` is the caller's logger;
// this module carries no logger, so it cannot log for itself.
export function dropUnsafeEntries(entries, onDropped = () => {}) {
  return entries.filter((e) => {
    if (!relKeyEscapes(e.relPath)) return true
    onDropped(e.relPath)
    return false
  })
}

// ─── containment / mount overlap ──────────────────────────────────────────────
// pathContains is contract/paths.js — core/ reads it too, and core/ may not import folders/.
export { pathContains }

// True when one path is the other, or one is an ancestor of the other. `fold` is passed
// through to pathContains for the filesystems that case-fold (darwin/win32).
export function pathsOverlap(a, b, sep, fold = false) {
  return pathContains(a, b, sep, fold) || pathContains(b, a, sep, fold)
}

// `pathsOverlap` reports raw geometry; this is the policy on top of it. An
// exactly-equal path is permitted between two owned (publish-only) folders, so one
// source tree can be shared into multiple spaces. Every other overlap stays
// rejected: nesting (a parent scan would absorb the child share's tree) and any
// overlap touching a foreign-folder (mirrors write to disk, so co-locating with an
// owned source feedback-loops and two mirrors on one path double-write).
export function overlapAllowed(aPath, aRole, bPath, bRole) {
  return aPath === bPath && aRole === 'owned-folder' && bRole === 'owned-folder'
}

// ─── ignore globs ─────────────────────────────────────────────────────────────
// The one matcher both sides of an owned folder ask: the recursive watcher in Electron main (as
// chokidar's per-instance `ignored`) and the periodic reconcile's disk walk. A second
// implementation is a share where a file one side withholds the other publishes.
export const DEFAULT_IGNORE = ['.DS_Store', 'Thumbs.db', '*' + PARTIAL_SUFFIX]

// Keyed on the caller's array identity. Patterns are matched per path per scan, so building the
// matcher per call would dominate the walk; every caller holds one array for the life of a walk or
// a watcher, and a WeakMap still lets a short-lived one be collected.
const matchers = new WeakMap()

function matcherFor(patterns) {
  let matcher = matchers.get(patterns)
  if (!matcher) {
    matcher = ignore().add(patterns.filter((pattern) => typeof pattern === 'string'))
    matchers.set(patterns, matcher)
  }
  return matcher
}

// A path outside the matcher's domain (absolute, escaping, empty) is published rather than
// withheld: asking about one raises, and this runs inside chokidar's ignore callback where a throw
// stops the watcher. The walk discards those shapes before they reach here for its own reasons.
export function shouldIgnore(rel, ignorePatterns) {
  if (!Array.isArray(ignorePatterns) || ignorePatterns.length === 0) return false
  if (!isPathValid(rel)) return false
  return matcherFor(ignorePatterns).ignores(rel)
}

// The subset of `shouldIgnore` a directory walk may act on. A trailing slash is what names a
// directory to the matcher, and nothing beneath an excluded directory can be re-included — so a
// descent skipped here drops only paths the per-file pass would have discarded anyway.
export function shouldPruneDir(rel, ignorePatterns) {
  if (typeof rel !== 'string') return false
  return shouldIgnore(rel.endsWith('/') ? rel : rel + '/', ignorePatterns)
}

// ─── mirror deletion safety ───────────────────────────────────────────────────
// Three TRUST gates say the listing is authoritative: owner online (the listing is live), non-empty
// (an all-empty listing is a replication gap, never "owner deleted everything"), and read to
// completion (a drain that timed out mid-tree is a PARTIAL list, indistinguishable from a real
// deletion, and likelier the bigger the folder). Two caps say it is PLAUSIBLE: `minDeletions` is a
// floor so ordinary tidying (and a small mirror emptying out) is never withheld; above it a pass may
// remove at most `maxDeletionRatio` of what the mirror owns, because a catalog that legitimately
// shrank by 99% and one read against a half-replicated core look the same here, and only one is
// recoverable. Tie goes to keeping the files. Both caps are parameters, not a config read, so the
// unit test drives its own; a caller that passes no counts gets deletionCount 0, under any floor —
// a guard that withheld everything when an argument was forgotten would be its own outage.
export function shouldHonorDeletions({
  ownerOnline, driveCount, listingComplete,
  syncedCount = 0, deletionCount = 0,
  minDeletions = 8, maxDeletionRatio = 0.5,
}) {
  if (!ownerOnline || !(driveCount > 0) || !listingComplete) return false
  if (deletionCount <= minDeletions) return true
  return deletionCount <= Math.max(minDeletions, Math.floor(syncedCount * maxDeletionRatio))
}

// ─── collision-free download/copy naming ──────────────────────────────────────
// Split a basename into { base, ext } the way `path.extname` does for a leaf name:
// extension is the substring from the last dot, except a leading dot (dotfile) or
// no dot yields no extension. 'a.tar.gz' → ext '.gz'; 'LICENSE'/'.bashrc' → ext ''.
export function splitFileName(fileName) {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return { base: fileName, ext: '' }
  return { base: fileName.slice(0, dot), ext: fileName.slice(dot) }
}

// Pick a name that `isTaken` reports free, suffixing " (1)", " (2)", … before the
// extension. `isTaken(name)` is supplied by the caller (it checks the filesystem
// for both the final file and an in-flight partial).
export function nextFreeName(fileName, isTaken) {
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

// The name a mirrored file's LOCAL edit is moved aside to before the owner's version is written
// back over the canonical path. A mirror is owner-authoritative — the owner's bytes belong at the
// natural name — but that does not require destroying what the user wrote. Same shape as every
// other file manager's conflict copy, and `nextFreeName` handles the second and third collision.
export function conflictCopyName(fileName, isTaken) {
  const { base, ext } = splitFileName(fileName)
  return nextFreeName(`${base} (conflicted copy)${ext}`, isTaken)
}

// ─── mount path rejection rules ───────────────────────────────────────────────
const SYSTEM_FOLDERS = {
  darwin: ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/private/var'],
  win32: ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'],
  linux: ['/proc', '/sys', '/dev', '/etc', '/boot', '/var/lib'],
}

const WIN_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

// Returns the offending system root (for the error message) or null.
export function systemRootViolation(normalized, platform, sep) {
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
export function personalRootViolation(normalized, home, sep, ci = false) {
  if (!home) return null
  const norm = ci ? normalized.toLowerCase() : normalized
  for (const root of [home, home + sep + 'Desktop', home + sep + 'Documents', home + sep + 'Downloads']) {
    if (norm === (ci ? root.toLowerCase() : root)) return root
  }
  return null
}

// A segment is reserved when its name before the first dot is a Windows device name.
export function isWindowsReservedName(segment) {
  return WIN_RESERVED.has(segment.split('.')[0].toUpperCase())
}

const CLOUD_HINTS = ['dropbox', 'onedrive', 'google drive', 'icloud', 'box', 'nextcloud', 'mega', 'proton drive', 'pcloud']

// Returns the matched cloud-sync provider hint (lower-case) if the path looks like
// it sits inside a cloud-sync folder, else null.
export function cloudSyncHint(lowerPath) {
  for (const hint of CLOUD_HINTS) {
    if (lowerPath.includes(hint)) return hint
  }
  return null
}
