import test from 'brittle'
import { basename, mountPathFromDrop, splitPathForDisplay, middleTruncateToWidth } from '../../src/renderer/model/share-paths.js'

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

// Middle truncation for every file and folder name: a long name becomes a single
// `High.Plains.Dri…BluRay.mp4` string that keeps both ends AND the extension.
// Tests use a monospace fake `measure` (1 unit per character) so widths are
// character counts and the assertions are exact.
const mono = (s) => [...new Intl.Segmenter().segment(s)].length

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

test('middleTruncateToWidth keeps a whole short extension in the tail', (t) => {
  const out = middleTruncateToWidth('quarterly-report-final.xlsx', 9, mono)
  t.is(mono(out), 9)
  t.ok(out.endsWith('.xlsx'), 'the extension stays whole even past half of what is shown')
})

test('REGRESSION (FIX-TRUNC-1: early dot collapsed to "…"): a dot inside a name is text, not an extension', (t) => {
  for (const name of [
    'Mr. Robot Season 1 Complete Collection Remastered',
    '2026.10 Client Masters Final Delivery Approved',
    'Release v1.5 Final Mix Masters',
    'logo.production',
  ]) {
    const out = middleTruncateToWidth(name, 12, mono)
    const [head, tail] = out.split('…')
    t.is(mono(out), 12, `${name}: grown to the budget`)
    t.ok(head.length > 0 && name.startsWith(head) && name.endsWith(tail), `${name}: both ends visible`)
    t.ok(mono(tail) >= mono(head), `${name}: the ending is at least half`)
  }
})

test('middleTruncateToWidth drops the extension rule when even the extension does not fit', (t) => {
  const out = middleTruncateToWidth('abcdefghij.mp4', 5, mono)
  t.is(out, 'ab…p4')
})

test('REGRESSION (FIX-TRUNC-2: emoji split into a lone surrogate): cuts fall on whole characters', (t) => {
  const emoji = middleTruncateToWidth('😀😀😀😀😀😀😀😀😀😀😀😀.txt', 10, mono)
  t.absent(/[\ud800-\udfff]/u.test(emoji.replace(/\p{Extended_Pictographic}/gu, '')), 'no lone surrogate')
  t.ok(emoji.endsWith('😀.txt') && emoji.startsWith('😀'), emoji)
  const nfd = middleTruncateToWidth('Re\u0301sume\u0301 Re\u0301sume\u0301 Re\u0301sume\u0301.pdf', 12, mono)
  t.absent(nfd.includes('…\u0301'), 'an accent never hangs on the ellipsis')
  t.ok(nfd.endsWith('e\u0301.pdf'), nfd)
})

test('middleTruncateToWidth middle-truncates extensionless names too', (t) => {
  const name = 'a-very-long-name-without-any-usable-extension'
  const out = middleTruncateToWidth(name, 15, mono)
  t.is(mono(out), 15)
  t.ok(out.includes('…') && out.startsWith('a-') , 'both the ellipsis and the head are present')
})

test('middleTruncateToWidth keeps the distinguishing end of a long stem, not just the extension', (t) => {
  const name = 'XXX-X002_T001_0401XI_16384x8192_25fps_40_part01.mov'
  const out = middleTruncateToWidth(name, 30, mono)
  t.is(mono(out), 30)
  t.ok(out.startsWith('XXX-X002_T001'), 'the beginning stays visible')
  t.ok(out.endsWith('_part01.mov'), 'the part number before the extension stays visible')
})

test('middleTruncateToWidth keeps the most characters a proportional font allows', (t) => {
  const wide = (s) => [...s].reduce((w, c) => w + (/[A-Z0-9_]/.test(c) ? 1.5 : 1), 0)
  const name = 'Quarterly_REPORT_final_2026_Q3_reviewed_by_LEGAL_v12.pdf'
  for (let budget = 8; budget < wide(name); budget += 0.5) {
    const out = middleTruncateToWidth(name, budget, wide)
    t.ok(wide(out) <= budget, `fits ${budget}`)
    const shown = out.length - 1
    if (shown >= name.length - 1) continue
    const tail = Math.max(Math.ceil((shown + 1) / 2), 4)
    const bigger = name.slice(0, shown + 1 - tail) + '…' + name.slice(name.length - tail)
    t.ok(wide(bigger) > budget, `one more character would not fit ${budget}`)
  }
})

test('middleTruncateToWidth degrades to a bare ellipsis when nothing fits', (t) => {
  t.is(middleTruncateToWidth('anything.mp4', 1, mono), '…')
})

test('middleTruncateToWidth tolerates empty / non-string input', (t) => {
  t.is(middleTruncateToWidth('', 10, mono), '')
  t.is(middleTruncateToWidth(null, 10, mono), '')
  t.is(middleTruncateToWidth(undefined, 10, mono), '')
})
