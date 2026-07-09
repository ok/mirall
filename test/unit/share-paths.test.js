import test from 'brittle'
import { basename, mountPathFromDrop, splitPathForDisplay, splitFilenameForDisplay, middleTruncateToWidth } from '../../src/renderer/sharePaths.js'

// The drop zone derives the mount path from webUtils.getPathForFile(file), which
// for a dropped FOLDER returns the folder's own absolute path. A regression
// (FIX-DROP-1) stripped the final segment, mounting the parent directory and
// naming the share after it ("user1" instead of "shared-folder1-user1").

test('REGRESSION (FIX-DROP-1): dropped folder resolves to itself, not its parent', (t) => {
  const dropped = '/Users/oliver/Projects/Mirall/test-data/test-userdata/user1/shared-folder1-user1'
  t.is(mountPathFromDrop(dropped), dropped, 'mount path is the dropped folder, not the parent')
  t.is(basename(mountPathFromDrop(dropped)), 'shared-folder1-user1', 'share name is the dropped folder name')
  t.not(basename(mountPathFromDrop(dropped)), 'user1', 'share name is NOT the parent directory name')
})

test('mountPathFromDrop trims a single trailing separator but keeps the folder', (t) => {
  t.is(mountPathFromDrop('/a/b/photos/'), '/a/b/photos')
  t.is(mountPathFromDrop('/a/b/photos'), '/a/b/photos')
  t.is(mountPathFromDrop('/a/b/photos///'), '/a/b/photos')
  t.is(mountPathFromDrop('C:\\Users\\me\\Docs\\'), 'C:\\Users\\me\\Docs')
})

test('mountPathFromDrop tolerates empty / non-string input', (t) => {
  t.is(mountPathFromDrop(''), '')
  t.is(mountPathFromDrop(null), '')
  t.is(mountPathFromDrop(undefined), '')
})

test('basename returns the last segment across separators and trailing slashes', (t) => {
  t.is(basename('/a/b/photos'), 'photos')
  t.is(basename('/a/b/photos/'), 'photos')
  t.is(basename('C:\\Users\\me\\Docs'), 'Docs')
  t.is(basename('C:\\Users\\me\\Docs\\'), 'Docs')
  t.is(basename('single'), 'single')
})

test('basename tolerates empty / non-string input', (t) => {
  t.is(basename(''), '')
  t.is(basename(null), '')
  t.is(basename(undefined), '')
})

test('splitPathForDisplay keeps the filename in the tail and the directory in the head', (t) => {
  t.alike(splitPathForDisplay('/Users/oliver/Projects/Mirall/app-storage'),
    { head: '/Users/oliver/Projects/Mirall', tail: '/app-storage' })
  t.alike(splitPathForDisplay('subfolder/garden-2.jpg'),
    { head: 'subfolder', tail: '/garden-2.jpg' })
  t.alike(splitPathForDisplay('C:\\Users\\me\\Docs'),
    { head: 'C:\\Users\\me', tail: '\\Docs' })
})

test('splitPathForDisplay returns a bare filename / root entry entirely as the tail', (t) => {
  t.alike(splitPathForDisplay('report.txt'), { head: '', tail: 'report.txt' })
  t.alike(splitPathForDisplay('/report.txt'), { head: '', tail: '/report.txt' })
  t.alike(splitPathForDisplay(''), { head: '', tail: '' })
  t.alike(splitPathForDisplay(null), { head: '', tail: '' })
})

// The transfer-row filename pins the extension (tail) so it stays visible while
// the stem ellipsizes — the filename analogue of splitPathForDisplay's tail.

test('splitFilenameForDisplay pins the extension and ellipsizes the stem', (t) => {
  t.alike(splitFilenameForDisplay('report_final_v2.pdf'), { head: 'report_final_v2', tail: '.pdf' })
  t.alike(splitFilenameForDisplay('IMG_1234.JPG'), { head: 'IMG_1234', tail: '.JPG' })
  // Multi-dot names pin only the final extension.
  t.alike(splitFilenameForDisplay('archive.tar.gz'), { head: 'archive.tar', tail: '.gz' })
  // A path is split at the last dot too: dirs + stem truncate, extension stays.
  t.alike(splitFilenameForDisplay('Photos/Summer/beach.jpg'), { head: 'Photos/Summer/beach', tail: '.jpg' })
})

test('splitFilenameForDisplay falls back to end truncation when there is no usable extension', (t) => {
  t.alike(splitFilenameForDisplay('README'), { head: 'README', tail: '' })
  t.alike(splitFilenameForDisplay('.gitignore'), { head: '.gitignore', tail: '' })
  t.alike(splitFilenameForDisplay('trailingdot.'), { head: 'trailingdot.', tail: '' })
})

test('splitFilenameForDisplay tolerates empty / non-string input', (t) => {
  t.alike(splitFilenameForDisplay(''), { head: '', tail: '' })
  t.alike(splitFilenameForDisplay(null), { head: '', tail: '' })
  t.alike(splitFilenameForDisplay(undefined), { head: '', tail: '' })
})

// Middle truncation for the confirm-modal titles: a long name becomes a single
// `High.Plains.Dri…BluRay.mp4` string that keeps both ends AND the extension.
// Tests use a monospace fake `measure` (1 unit per char) so widths are char
// counts and the assertions are exact.
const mono = (s) => s.length

test('middleTruncateToWidth returns a name that already fits unchanged', (t) => {
  t.is(middleTruncateToWidth('notes.txt', 20, mono), 'notes.txt')
  t.is(middleTruncateToWidth('notes.txt', 9, mono), 'notes.txt')
})

test('middleTruncateToWidth keeps both ends and the extension when it truncates', (t) => {
  const name = 'High.Plains.Drifter.1972.1080p.BluRay.mp4'
  const out = middleTruncateToWidth(name, 20, mono)
  t.is(mono(out), 20, 'the result is grown to exactly the budget')
  t.ok(out.includes('…'), 'it middle-truncates with an ellipsis')
  t.ok(out.startsWith('High'), 'the beginning stays visible')
  t.ok(out.endsWith('.mp4'), 'the extension stays in the visible ending')
})

test('middleTruncateToWidth always keeps the whole extension in the tail', (t) => {
  // Even a long extension is preserved whole; the head shrinks to make room.
  const out = middleTruncateToWidth('logo.production', 8, mono)
  t.ok(out.endsWith('.production') || out === '…', 'extension survives or degrades to just the ellipsis')
})

test('middleTruncateToWidth middle-truncates extensionless names too', (t) => {
  const name = 'a-very-long-name-without-any-usable-extension'
  const out = middleTruncateToWidth(name, 15, mono)
  t.is(mono(out), 15)
  t.ok(out.includes('…') && out.startsWith('a-') , 'both the ellipsis and the head are present')
})

test('middleTruncateToWidth degrades to a bare ellipsis when nothing fits', (t) => {
  t.is(middleTruncateToWidth('anything.mp4', 1, mono), '…')
})

test('middleTruncateToWidth tolerates empty / non-string input', (t) => {
  t.is(middleTruncateToWidth('', 10, mono), '')
  t.is(middleTruncateToWidth(null, 10, mono), '')
  t.is(middleTruncateToWidth(undefined, 10, mono), '')
})
