import test from 'brittle'
import path from 'node:path'
import {
  relToDriveKey, driveKeyToSegments,
  stripLongPathPrefix, isAbsoluteDriveKey, relKeyEscapes,
  sharePrefix, isInsideShare, isInsideAnyShare, relPathInShare,
  pathsOverlap, overlapAllowed,
  DEFAULT_IGNORE, shouldIgnore,
  shouldHonorDeletions,
  splitFileName, nextFreeName,
  systemRootViolation, personalRootViolation, isWindowsReservedName, firstWinReservedSegment, cloudSyncHint,
} from '../../src/shared/folders/path-keys.js'

// These pure helpers are the platform-divergent backbone of every file/folder
// operation (share, subfolder, move, copy, delete). They were previously trapped
// in modules that import `bare-*` (so only reachable under brittle-bare); extracted
// to `path-keys.js` they can be unit-tested directly, including Windows behaviour
// on a POSIX machine by passing an explicit `\` separator.

// ── SEV-1 #1: relPath ⇄ drive-key separator mapping ────────────────────────────
test('relToDriveKey converts the OS separator to POSIX drive-key form', (t) => {
  t.is(relToDriveKey('sub/a.txt', '/'), 'sub/a.txt', 'POSIX rel is unchanged')
  t.is(relToDriveKey('sub\\deep\\a.txt', '\\'), 'sub/deep/a.txt', 'Windows rel → POSIX key')
  t.is(relToDriveKey('a.txt', '/'), 'a.txt', 'top-level file, no separator')
  t.is(relToDriveKey('a.txt', '\\'), 'a.txt', 'top-level file on Windows')
})

test('driveKeyToSegments splits a key for path.join(root, ...segments)', (t) => {
  t.alike(driveKeyToSegments('sub/deep/a.txt'), ['sub', 'deep', 'a.txt'])
  t.alike(driveKeyToSegments('a.txt'), ['a.txt'])
})

test('rel ⇄ key round-trips on both POSIX and Windows separators', (t) => {
  for (const sep of ['/', '\\']) {
    for (const key of ['a.txt', 'sub/a.txt', 'one/two/three/file.bin']) {
      const segs = driveKeyToSegments(key)
      const rel = segs.join(sep)              // what path.join(...segs) yields per-OS
      t.is(relToDriveKey(rel, sep), key, `round-trip ${JSON.stringify(key)} via ${JSON.stringify(sep)}`)
    }
  }
})

// ── Windows long-path prefix (FIX-126) ─────────────────────────────────────────
test('stripLongPathPrefix removes the Windows device / UNC prefix, leaves the rest', (t) => {
  t.is(stripLongPathPrefix('\\\\?\\E:\\Musik\\x.mp3'), 'E:\\Musik\\x.mp3', 'drive device prefix stripped')
  t.is(stripLongPathPrefix('\\\\?\\UNC\\server\\share\\x'), '\\\\server\\share\\x', 'UNC prefix → real \\\\server\\share')
  t.is(stripLongPathPrefix('E:\\Musik\\x.mp3'), 'E:\\Musik\\x.mp3', 'unprefixed Windows path unchanged')
  t.is(stripLongPathPrefix('/home/u/x.mp3'), '/home/u/x.mp3', 'POSIX path unchanged')
  t.is(stripLongPathPrefix('sub/a.txt'), 'sub/a.txt', 'relative path unchanged')
})

test('isAbsoluteDriveKey rejects absolute / rooted keys, accepts share-relative ones', (t) => {
  for (const bad of ['', '/x', '\\x', 'E:/Musik/x', 'e:/x', '//?/E:/Musik/x', '\\\\?\\E:\\x']) {
    t.ok(isAbsoluteDriveKey(bad), `rejects ${JSON.stringify(bad)}`)
  }
  for (const ok of ['a.txt', 'sub/a.txt', 'one/two/file.bin', '[CLV002]/05.mp3']) {
    t.absent(isAbsoluteDriveKey(ok), `accepts ${JSON.stringify(ok)}`)
  }
})

// REGRESSION (FIX-126): a Windows owned-folder shared `E:\Musik\Clivage Music`.
// Under Bare, recursive readdir returned a `\\?\E:\…`-prefixed file path while the
// stored mount root had no prefix. `path.relative(root, abs)` between the `E:\`
// drive and the `\\?\E:\` device namespace returns the absolute target verbatim,
// so the drive key became the leaked `//?/E:/Musik/…` absolute path seen in the
// folder view (and reveal then failed). Reproduced here with Node's win32 path
// engine so it runs on any OS.
test('REGRESSION (FIX-126): `\\\\?\\` prefix mismatch no longer corrupts the drive key', (t) => {
  const root = 'E:\\Musik\\Clivage Music'                                 // stored mount, no prefix
  const abs = '\\\\?\\E:\\Musik\\Clivage Music\\[CLV002]\\05_Use It.mp3'   // bare-fs parentPath, prefixed

  // The bug, documented: relative across mismatched roots yields the absolute path.
  const buggy = relToDriveKey(path.win32.relative(root, abs), '\\')
  t.is(buggy, '//?/E:/Musik/Clivage Music/[CLV002]/05_Use It.mp3', 'unfixed path.relative leaks the absolute key')
  t.ok(isAbsoluteDriveKey(buggy), 'the leaked key is detectably absolute')

  // The fix: normalize both sides into one namespace first → clean relative key.
  const fixed = relToDriveKey(
    path.win32.relative(stripLongPathPrefix(root), stripLongPathPrefix(abs)),
    '\\',
  )
  t.is(fixed, '[CLV002]/05_Use It.mp3', 'stripping the prefix restores the in-share relative key')
  t.absent(isAbsoluteDriveKey(fixed), 'the fixed key passes the absolute-key guard')
})

// ── SEV-1 #2: share prefix + membership ────────────────────────────────────────
test('sharePrefix wraps a share name in leading/trailing slashes', (t) => {
  t.is(sharePrefix('Docs'), '/Docs/')
  t.is(sharePrefix('My Folder 2024'), '/My Folder 2024/')
})

test('isInsideShare matches files in the folder and its subfolders, not a name-prefix sibling', (t) => {
  const p = sharePrefix('Docs')
  t.ok(isInsideShare('/Docs/a.txt', p), 'direct child')
  t.ok(isInsideShare('/Docs/sub/deep/a.txt', p), 'nested subfolder file')
  t.absent(isInsideShare('/Docsfoo/a.txt', p), 'name-prefix sibling is NOT inside (the boundary bug)')
  t.absent(isInsideShare('/Other/a.txt', p), 'unrelated folder')
  t.absent(isInsideShare('/loose.txt', p), 'loose top-level file')
})

test('isInsideAnyShare is true iff the key is inside one of the prefixes', (t) => {
  const prefixes = [sharePrefix('Docs'), sharePrefix('Photos')]
  t.ok(isInsideAnyShare('/Photos/2024/x.jpg', prefixes))
  t.ok(isInsideAnyShare('/Docs/a.txt', prefixes))
  t.absent(isInsideAnyShare('/Music/a.mp3', prefixes))
  t.absent(isInsideAnyShare('/Photosextra/x.jpg', prefixes), 'name-prefix sibling excluded')
  t.absent(isInsideAnyShare('/anything', []), 'no shares → never inside')
})

test('relPathInShare strips the prefix and preserves subfolder structure', (t) => {
  const p = sharePrefix('Docs')
  t.is(relPathInShare('/Docs/a.txt', p), 'a.txt')
  t.is(relPathInShare('/Docs/sub/deep/a.txt', p), 'sub/deep/a.txt')
})

// ── SEV-1 #3: mount overlap ────────────────────────────────────────────────────
test('pathsOverlap detects equal / ancestor / descendant, not a shared-prefix sibling', (t) => {
  t.ok(pathsOverlap('/a/b', '/a/b', '/'), 'equal')
  t.ok(pathsOverlap('/a', '/a/b', '/'), 'a is ancestor of b')
  t.ok(pathsOverlap('/a/b/c', '/a/b', '/'), 'descendant of b')
  t.absent(pathsOverlap('/a/b', '/a/bc', '/'), 'sibling sharing a name prefix does NOT overlap')
  t.absent(pathsOverlap('/a/b', '/x/y', '/'), 'unrelated')
})

test('pathsOverlap honours the Windows separator', (t) => {
  t.ok(pathsOverlap('C:\\Users\\me', 'C:\\Users\\me\\Docs', '\\'), 'ancestor on Windows')
  t.absent(pathsOverlap('C:\\Users\\me', 'C:\\Users\\meeting', '\\'), 'name-prefix sibling on Windows')
})

// ── mount overlap POLICY (overlapAllowed) ──────────────────────────────────────
test('overlapAllowed permits an exactly-equal path only between two owned folders', (t) => {
  t.ok(overlapAllowed('/a/b', 'owned-folder', '/a/b', 'owned-folder'),
    'equal path, owned↔owned → allowed (same folder, two spaces)')
  t.absent(overlapAllowed('/a/b', 'owned-folder', '/a/b', 'foreign-folder'),
    'equal path but a mirror is involved → blocked (mirror writes to disk)')
  t.absent(overlapAllowed('/a/b', 'foreign-folder', '/a/b', 'owned-folder'),
    'equal path, new mirror over an owned source → blocked (feedback loop)')
  t.absent(overlapAllowed('/a/b', 'foreign-folder', '/a/b', 'foreign-folder'),
    'two mirrors on one path → blocked (double-write)')
})

test('overlapAllowed never permits nesting, even owned↔owned', (t) => {
  t.absent(overlapAllowed('/a/b', 'owned-folder', '/a', 'owned-folder'),
    'child vs parent is not equal → not allowed')
  t.absent(overlapAllowed('/a', 'owned-folder', '/a/b', 'owned-folder'),
    'parent vs child is not equal → not allowed')
})

// ── SEV-2 #4: collision-free download/copy naming ──────────────────────────────
test('splitFileName mirrors path.extname for leaf names', (t) => {
  t.alike(splitFileName('report.txt'), { base: 'report', ext: '.txt' })
  t.alike(splitFileName('archive.tar.gz'), { base: 'archive.tar', ext: '.gz' }, 'extension is the last dot only')
  t.alike(splitFileName('LICENSE'), { base: 'LICENSE', ext: '' }, 'no dot → no extension')
  t.alike(splitFileName('.bashrc'), { base: '.bashrc', ext: '' }, 'leading-dot dotfile → no extension')
  t.alike(splitFileName('file.'), { base: 'file', ext: '.' }, 'trailing dot')
})

test('nextFreeName returns the name unchanged when nothing is taken', (t) => {
  t.is(nextFreeName('report.txt', () => false), 'report.txt')
})

test('nextFreeName walks " (n)" before the extension until a free name is found', (t) => {
  const taken = new Set(['report.txt', 'report (1).txt', 'report (2).txt'])
  t.is(nextFreeName('report.txt', (n) => taken.has(n)), 'report (3).txt')
})

test('nextFreeName suffixes extension-less names correctly', (t) => {
  const taken = new Set(['LICENSE'])
  t.is(nextFreeName('LICENSE', (n) => taken.has(n)), 'LICENSE (1)')
})

test('nextFreeName treats an in-flight partial as taken (injected probe)', (t) => {
  // Mirrors resolveDest: a name is taken if either the file OR its partial exists.
  const onDisk = new Set(['big.iso.mirall.part'])
  const isTaken = (n) => onDisk.has(n) || onDisk.has(n + '.mirall.part')
  t.is(nextFreeName('big.iso', isTaken), 'big (1).iso', 'avoids colliding with an in-progress download')
})

// ── SEV-2 #5: mirror deletion safety ───────────────────────────────────────────
test('shouldHonorDeletions: only when owner online AND listing non-empty AND read to completion', (t) => {
  t.ok(shouldHonorDeletions({ ownerOnline: true, driveCount: 3, listingComplete: true }), 'online + non-empty + complete → honor')
  t.absent(shouldHonorDeletions({ ownerOnline: true, driveCount: 0, listingComplete: true }), 'empty listing → suspect, do not delete')
  t.absent(shouldHonorDeletions({ ownerOnline: false, driveCount: 3, listingComplete: true }), 'owner offline → stale, do not delete')
  t.absent(shouldHonorDeletions({ ownerOnline: false, driveCount: 0, listingComplete: true }), 'offline + empty → do not delete')
})

// FIX-359: a partial (timed-out) drain returns a non-empty listing that is NOT authoritative.
// The full regression story lives in test/integration/foreign-del-guard.test.js.
test('FIX-359: a truncated-but-non-empty listing must NOT authorize deletions', (t) => {
  t.absent(shouldHonorDeletions({ ownerOnline: true, driveCount: 4200, listingComplete: false }), 'partial drain → do NOT delete')
})

// ── SEV-2 #6: ignore-glob matcher ──────────────────────────────────────────────
test('shouldIgnore: exact basename anywhere in the tree', (t) => {
  t.ok(shouldIgnore('.DS_Store', DEFAULT_IGNORE))
  t.ok(shouldIgnore('sub/deep/.DS_Store', DEFAULT_IGNORE), 'matches by basename in a subfolder')
  t.ok(shouldIgnore('Thumbs.db', DEFAULT_IGNORE))
})

test('shouldIgnore: suffix globs match the end, not a prefix', (t) => {
  t.ok(shouldIgnore('big.iso.mirall.part', DEFAULT_IGNORE))
  t.ok(shouldIgnore('a/b/download.mirall.part', DEFAULT_IGNORE), 'in a subfolder')
  t.ok(shouldIgnore('notes.txt~', DEFAULT_IGNORE))
  t.absent(shouldIgnore('part.txt', DEFAULT_IGNORE), 'prefix, not suffix → not ignored')
  // Only OUR token is excluded. A bare `*.part` glob would silently drop a third-party
  // in-progress download — or any legitimately named file — out of an owned folder.
  t.absent(shouldIgnore('big.iso.part', DEFAULT_IGNORE), "another app's .part is publishable")
  t.absent(shouldIgnore('big.iso.partial', DEFAULT_IGNORE), "another app's .partial is publishable")
})

test('shouldIgnore: dir/** matches the dir and everything under it, not look-alikes', (t) => {
  t.ok(shouldIgnore('.git', DEFAULT_IGNORE), 'the directory itself')
  t.ok(shouldIgnore('.git/config', DEFAULT_IGNORE))
  t.ok(shouldIgnore('node_modules/pkg/deep/index.js', DEFAULT_IGNORE), 'deeply nested')
  t.absent(shouldIgnore('src/.gitignore', DEFAULT_IGNORE), '.gitignore is not .git/**')
  t.absent(shouldIgnore('my-node_modules-notes.md', DEFAULT_IGNORE))
})

test('shouldIgnore: ordinary files pass; empty/missing patterns ignore nothing', (t) => {
  t.absent(shouldIgnore('docs/readme.md', DEFAULT_IGNORE))
  t.absent(shouldIgnore('.DS_Store', []))
  t.absent(shouldIgnore('.DS_Store', undefined))
})

// ── SEV-3 #7: mount path name rules ────────────────────────────────────────────
test('systemRootViolation returns the offending root per platform', (t) => {
  t.is(systemRootViolation('/usr/local/share', 'darwin', '/'), '/usr', 'macOS system root')
  t.is(systemRootViolation('/etc/hosts', 'linux', '/'), '/etc', 'linux system root')
  t.is(systemRootViolation('C:\\Windows\\System32', 'win32', '\\'), 'C:\\Windows', 'windows system root')
  t.is(systemRootViolation('/Users/me/Docs', 'darwin', '/'), null, 'a home path is allowed')
  t.is(systemRootViolation('/usrfoo/x', 'darwin', '/'), null, 'name-prefix sibling of /usr is allowed')
})

// ── MIR-10: personal-root mount guard (exact-equality, never a prefix) ──────────
test('personalRootViolation rejects only the bare personal roots, never a subfolder', (t) => {
  const home = '/Users/me'
  t.is(personalRootViolation(home, home, '/'), home, '$HOME itself is rejected')
  t.is(personalRootViolation(home + '/Desktop', home, '/'), home + '/Desktop', 'Desktop root rejected')
  t.is(personalRootViolation(home + '/Documents', home, '/'), home + '/Documents', 'Documents root rejected')
  t.is(personalRootViolation(home + '/Downloads', home, '/'), home + '/Downloads', 'Downloads root rejected')
  t.is(personalRootViolation(home + '/Documents/ProjectX', home, '/'), null, 'a subfolder is allowed')
  t.is(personalRootViolation(home + '/Pictures', home, '/'), null, 'an unlisted personal folder is allowed')
  t.is(personalRootViolation('/some/other/place', home, '/'), null, 'an unrelated path is allowed')
  t.is(personalRootViolation(home, '', '/'), null, 'no home → no violation')
})

test('personalRootViolation folds case only when asked (case-insensitive filesystems)', (t) => {
  const home = '/Users/me'
  t.is(personalRootViolation('/Users/me/documents', home, '/', false), null, 'case-sensitive: lower-case typo slips through')
  t.is(personalRootViolation('/Users/me/documents', home, '/', true), home + '/Documents', 'case-insensitive: lower-case typo matches the real root')
})

test('isWindowsReservedName matches device names ignoring extension and case', (t) => {
  t.ok(isWindowsReservedName('CON'))
  t.ok(isWindowsReservedName('con.txt'), 'reserved even with an extension')
  t.ok(isWindowsReservedName('LPT1'))
  t.absent(isWindowsReservedName('CONSOLE'), 'longer name is not reserved')
  t.absent(isWindowsReservedName('Documents'))
})

test('firstWinReservedSegment finds a reserved segment anywhere in the path', (t) => {
  t.is(firstWinReservedSegment('C:\\Users\\me\\NUL\\x', '\\'), 'NUL')
  t.is(firstWinReservedSegment('C:\\Users\\me\\Docs', '\\'), null)
})

// ── SEV-3 #8: cloud-sync detection (gates a hard mount rejection) ───────────────
test('cloudSyncHint detects cloud-sync provider folders (lower-cased input)', (t) => {
  t.is(cloudSyncHint('/users/me/dropbox/shared'), 'dropbox')
  t.is(cloudSyncHint('c:\\users\\me\\onedrive\\docs'), 'onedrive')
  t.is(cloudSyncHint('/users/me/library/mobile documents/icloud'), 'icloud')
  t.is(cloudSyncHint('/users/me/projects/mirall'), null, 'an ordinary folder has no hint')
})

// ── MIR-06: materialize containment guard ──────────────────────────────────────
test('relKeyEscapes rejects traversal / absolute / empty keys, accepts clean rel keys', (t) => {
  for (const bad of [
    '', '.', '..',
    '../x', 'a/../../x', 'a/./b',
    '/abs/x', '\\unc\\x', 'E:/x', 'e:/x',
    'a//b',                       // empty segment from a double slash
    '..\\..\\x',                  // Windows backslash traversal smuggled in one segment
    'sub/..\\..\\x',
  ]) t.ok(relKeyEscapes(bad), `rejects ${JSON.stringify(bad)}`)

  for (const ok of ['a.txt', 'sub/a.txt', 'one/two/three.bin', 'My Folder/a b.txt', '[CLV002]/05.mp3']) {
    t.absent(relKeyEscapes(ok), `accepts ${JSON.stringify(ok)}`)
  }
})

// REGRESSION (MIR-06): the exact PoC keys that escaped the mount must be rejected,
// and a legitimate sibling in the same share must still be accepted. Fails on the
// unfixed tree (no relKeyEscapes), passes only with the containment guard.
test('REGRESSION (MIR-06): containment guard rejects the PoC traversal keys', (t) => {
  t.ok(relKeyEscapes('../../../../../../tmp/PWNED'), 'the PoC deletion key is rejected')
  t.ok(relKeyEscapes('../../../tmp/x'), 'multi-level climb rejected')
  t.ok(relKeyEscapes('../tmp/evil'), 'single-level climb rejected')
  t.absent(relKeyEscapes('real.txt'), 'a legitimate sibling key in the same share is accepted')
})

// REGRESSION (MIR-23): the same guard contains the OWNER serve path (the overlay
// backend + worker/main.js pathFromMount). A peer-supplied serve relPath that
// climbs out of the mount must be rejected before any read/hash.
test('REGRESSION (MIR-23): content-backend serve path rejects the read PoC keys', (t) => {
  t.ok(relKeyEscapes('../../../../etc/passwd'), 'the serve PoC read key is rejected')
  t.ok(relKeyEscapes('..\\..\\Windows\\System32\\drivers\\etc\\hosts'), 'Windows-separator traversal rejected')
  t.absent(relKeyEscapes('reports/q3.pdf'), 'a legitimate advertised file is accepted')
})
