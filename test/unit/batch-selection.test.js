import test from 'brittle'
import {
  AT_REST, TOP_BOX, triState, toggleKeys, dirId, gestureOf, visibleOrder, collectTreeKeys, keysFor,
  rangeKeys, nextSelection, selectAllMatching, keepMatching, summarize,
} from '../../src/renderer/model/batch-selection.js'
import { buildFileTree } from '../../src/renderer/model/file-tree.js'

// The mockup's folder: two folders, one nested, and loose files at the root.
const PATHS = [
  'Contracts/Agreement-2026.pdf', 'Contracts/Invoice-0412.pdf', 'Contracts/Invoice-0413.pdf',
  'Photos/raw/site-01.cr3', 'Photos/raw/site-02.cr3', 'Photos/site-01.jpg',
  'Floorplan-final.pdf', 'Handover-notes.md',
]
const row = (relPath, status = 'remote', size = 10) => ({ relPath, size, hash: 'h', mtime: 0, localPath: null, status })
const tree = buildFileTree(PATHS.map((p) => row(p)))
const expandedAll = () => true
const expandedTop = (path) => path === 'Contracts' || path === 'Photos'
const { keys: ALL, under, shown: SHOWN } = collectTreeKeys(tree)
const filesUnder = (path) => under.get(path) ?? []
const ctx = (over = {}) => ({ order: visibleOrder(tree, expandedAll), filesUnder, matching: ALL, ...over })

test('triState: empty → off, none → off, some → mixed, all → on; keys not in the listing are ignored', (t) => {
  t.is(triState([], new Set(['a'])), 'off')
  t.is(triState(['a', 'b'], new Set()), 'off')
  t.is(triState(['a', 'b'], new Set(['a'])), 'mixed')
  t.is(triState(['a', 'b'], new Set(['a', 'b', 'gone'])), 'on')
})

test('toggleKeys: a mixed folder turns all on, an all-on folder turns all off, an explicit `on` wins', (t) => {
  const keys = ['a', 'b']
  t.alike([...toggleKeys(new Set(['a']), keys)].sort(), ['a', 'b'])
  t.alike([...toggleKeys(new Set(['a', 'b']), keys)], [])
  t.alike([...toggleKeys(new Set(['a', 'b']), keys, true)].sort(), ['a', 'b'])
  const before = new Set(['a'])
  toggleKeys(before, keys)
  t.alike([...before], ['a'], 'the input set is never mutated')
})

test('visibleOrder: depth-first with folder ids interleaved; a collapsed folder hides its children', (t) => {
  t.alike(visibleOrder(tree, expandedAll), [
    dirId('Contracts'), 'Contracts/Agreement-2026.pdf', 'Contracts/Invoice-0412.pdf', 'Contracts/Invoice-0413.pdf',
    dirId('Photos'), dirId('Photos/raw'), 'Photos/raw/site-01.cr3', 'Photos/raw/site-02.cr3', 'Photos/site-01.jpg',
    'Floorplan-final.pdf', 'Handover-notes.md',
  ])
  t.alike(visibleOrder(tree, expandedTop), [
    dirId('Contracts'), 'Contracts/Agreement-2026.pdf', 'Contracts/Invoice-0412.pdf', 'Contracts/Invoice-0413.pdf',
    dirId('Photos'), dirId('Photos/raw'), 'Photos/site-01.jpg',
    'Floorplan-final.pdf', 'Handover-notes.md',
  ], 'the collapsed raw/ keeps its row but hides its files')
})

test('collectTreeKeys: every file, the files under each folder, and a selectable predicate that drops rows', (t) => {
  t.is(ALL.size, 8)
  t.is(SHOWN.size, 8, 'shown is every file the tree lists')
  t.alike(filesUnder('Photos'), ['Photos/raw/site-01.cr3', 'Photos/raw/site-02.cr3', 'Photos/site-01.jpg'])
  t.alike(filesUnder('Photos/raw'), ['Photos/raw/site-01.cr3', 'Photos/raw/site-02.cr3'])
  const { keys, under: u, shown } = collectTreeKeys(tree, (key) => !key.startsWith('Photos/raw/'))
  t.is(keys.size, 6)
  t.is(shown.size, 8, 'a row without a box is still shown')
  t.alike(u.get('Photos/raw'), [], 'a folder of unselectable rows stands for nothing')
})

test('keysFor: a file is itself, a folder is its files, a file outside the matching set is nothing', (t) => {
  t.alike(keysFor('Floorplan-final.pdf', ctx()), ['Floorplan-final.pdf'])
  t.alike(keysFor(dirId('Contracts'), ctx()), ['Contracts/Agreement-2026.pdf', 'Contracts/Invoice-0412.pdf', 'Contracts/Invoice-0413.pdf'])
  t.alike(keysFor('Floorplan-final.pdf', ctx({ matching: new Set() })), [], 'a box-less row stands for nothing')
})

test('rangeKeys: within a folder, across a collapsed folder row, in reverse, with no anchor, and anchor equal to target', (t) => {
  const c = ctx({ order: visibleOrder(tree, expandedTop) })
  t.alike(rangeKeys('Contracts/Agreement-2026.pdf', 'Contracts/Invoice-0413.pdf', c),
    ['Contracts/Agreement-2026.pdf', 'Contracts/Invoice-0412.pdf', 'Contracts/Invoice-0413.pdf'])
  t.alike(rangeKeys('Contracts/Invoice-0413.pdf', 'Photos/site-01.jpg', c),
    ['Contracts/Invoice-0413.pdf', 'Photos/raw/site-01.cr3', 'Photos/raw/site-02.cr3', 'Photos/site-01.jpg', 'Photos/raw/site-01.cr3', 'Photos/raw/site-02.cr3', 'Photos/site-01.jpg'],
    'a range across Photos and its collapsed raw/ takes every file below both rows')
  t.alike(rangeKeys('Photos/site-01.jpg', 'Contracts/Invoice-0413.pdf', c).length, 7, 'reverse direction is the same set')
  t.alike(rangeKeys(null, 'Floorplan-final.pdf', c), ['Floorplan-final.pdf'])
  t.alike(rangeKeys('gone', 'Floorplan-final.pdf', c), ['Floorplan-final.pdf'], 'an anchor that left the order')
  t.alike(rangeKeys('Floorplan-final.pdf', 'Floorplan-final.pdf', c), ['Floorplan-final.pdf'])
  const partial = ctx({ order: visibleOrder(tree, expandedTop), matching: new Set(['Contracts/Agreement-2026.pdf', 'Photos/site-01.jpg']) })
  t.alike([...new Set(rangeKeys('Contracts/Agreement-2026.pdf', 'Handover-notes.md', partial))], ['Contracts/Agreement-2026.pdf', 'Photos/site-01.jpg'], 'a range skips every row without a box')
})

test('nextSelection: a gesture that yields no key is not a selection gesture', (t) => {
  const open = { mode: true, selected: new Set(), anchor: null }
  t.is(nextSelection(open, 'Floorplan-final.pdf', 'toggle', ctx({ matching: new Set() })), null, 'a click on a box-less row')
  t.is(nextSelection(AT_REST, 'Floorplan-final.pdf', 'toggle-mod', ctx({ matching: new Set() })), null, 'a modified click at rest on one too')
})

test('the top box and folder ids cannot collide with a file named like them', (t) => {
  const tricky = buildFileTree([row('all'), row('dir:x')])
  const { keys } = collectTreeKeys(tricky)
  const c = ctx({ order: visibleOrder(tricky, expandedAll), matching: keys, filesUnder: () => [] })
  t.alike([...nextSelection(AT_REST, 'all', 'toggle-mod', c).selected], ['all'], 'a file named all is a file')
  t.alike([...nextSelection(AT_REST, 'dir:x', 'toggle-mod', c).selected], ['dir:x'], 'and so is one named dir:x')
  t.is(nextSelection(AT_REST, TOP_BOX, 'toggle', c).selected.size, 2)
})

test('gestureOf: shift is a range, the platform key a toggle that opens the column, else a plain toggle', (t) => {
  t.is(gestureOf({ shiftKey: true, metaKey: true, ctrlKey: false }), 'range')
  t.is(gestureOf({ shiftKey: false, metaKey: true, ctrlKey: false }), 'toggle-mod')
  t.is(gestureOf({ shiftKey: false, metaKey: false, ctrlKey: true }), 'toggle-mod')
  t.is(gestureOf({ shiftKey: false, metaKey: false, ctrlKey: false }), 'toggle')
})

// The gesture table, one case per row. At rest the column is closed; selecting it is open.
test('nextSelection: the top box', (t) => {
  const opened = nextSelection(AT_REST, TOP_BOX, 'toggle', ctx())
  t.ok(opened.mode, 'the first tick opens the column')
  t.is(opened.selected.size, 8, 'with every matching file selected')
  const cleared = nextSelection(opened, TOP_BOX, 'toggle', ctx())
  t.ok(cleared.mode, 'the column outlives an empty selection')
  t.is(cleared.selected.size, 0)
  const some = { mode: true, selected: new Set(['Floorplan-final.pdf']), anchor: null }
  t.is(nextSelection(some, TOP_BOX, 'toggle', ctx()).selected.size, 8, 'a mixed top box turns everything on')
  const filtered = ctx({ matching: new Set(['Contracts/Invoice-0412.pdf', 'Contracts/Invoice-0413.pdf']) })
  t.alike([...nextSelection(AT_REST, TOP_BOX, 'toggle', filtered).selected].sort(), ['Contracts/Invoice-0412.pdf', 'Contracts/Invoice-0413.pdf'], 'only the matching files')
})

test('nextSelection: at rest only a modified click selects; a plain click and a shift-click are not selection gestures', (t) => {
  t.is(nextSelection(AT_REST, 'Floorplan-final.pdf', 'toggle', ctx()), null)
  t.is(nextSelection(AT_REST, 'Floorplan-final.pdf', 'range', ctx()), null)
  t.is(nextSelection(AT_REST, dirId('Photos'), 'range', ctx()), null, 'shift on a folder row at rest expands it')
  const next = nextSelection(AT_REST, 'Floorplan-final.pdf', 'toggle-mod', ctx())
  t.ok(next.mode)
  t.alike([...next.selected], ['Floorplan-final.pdf'])
  t.is(next.anchor, 'Floorplan-final.pdf')
  const folder = nextSelection(AT_REST, dirId('Photos'), 'toggle-mod', ctx())
  t.is(folder.selected.size, 3, 'a modified click on a folder row selects its files')
  t.is(folder.anchor, dirId('Photos'))
})

test('nextSelection: while selecting a click toggles and moves the anchor, a shift-click extends the range from the anchor', (t) => {
  const start = nextSelection(AT_REST, 'Contracts/Agreement-2026.pdf', 'toggle-mod', ctx())
  const two = nextSelection(start, 'Contracts/Invoice-0412.pdf', 'toggle', ctx())
  t.is(two.selected.size, 2)
  t.is(two.anchor, 'Contracts/Invoice-0412.pdf')
  const off = nextSelection(two, 'Contracts/Invoice-0412.pdf', 'toggle', ctx())
  t.is(off.selected.size, 1, 'a second click on a ticked row unticks it')
  const ranged = nextSelection(two, 'Photos/site-01.jpg', 'range', ctx())
  t.is(ranged.selected.size, 6, 'the range from the anchor is turned on')
  t.is(ranged.anchor, 'Contracts/Invoice-0412.pdf', 'the anchor stays where it was')
  const folderOff = nextSelection(ranged, dirId('Contracts'), 'toggle', ctx())
  t.is(folderOff.selected.size, 3, 'a folder box on a fully selected folder turns its files off')
  const modSame = nextSelection(two, 'Floorplan-final.pdf', 'toggle-mod', ctx())
  t.is(modSame.selected.size, 3, 'a modified click while selecting toggles like a plain one')
})

test('selectAllMatching and keepMatching', (t) => {
  const some = { mode: false, selected: new Set(['Handover-notes.md']), anchor: null }
  const all = selectAllMatching(some, new Set(['Floorplan-final.pdf']))
  t.ok(all.mode)
  t.alike([...all.selected].sort(), ['Floorplan-final.pdf', 'Handover-notes.md'], 'adds the matching set to what was ticked')
  t.alike([...keepMatching(new Set(['a', 'b', 'c']), new Set(['b']))], ['b'])
})

test('summarize: counts, hidden, buckets from verbsOf, the byte sum, and a key whose row left the listing', (t) => {
  const rows = [row('a', 'remote', 5), row('b', 'downloading', 7), row('c', 'downloaded', 9), row('d', 'synced', 1)]
  const verbsOf = (r) => ({ download: r.status === 'remote', inProgress: r.status === 'downloading', unshare: r.status === 'synced', onDevice: r.status === 'downloaded' })
  const s = summarize({ rows, keyOf: (r) => r.relPath, sizeOf: (r) => r.size, selected: new Set(['a', 'b', 'c', 'd', 'ghost']), shown: new Set(['a', 'b']), verbsOf })
  t.is(s.count, 4, 'the ghost key counts for nothing')
  t.is(s.bytes, 22)
  t.is(s.hidden, 2)
  t.is(s.onDevice, 1)
  t.alike(s.download.map((r) => r.relPath), ['a'])
  t.alike(s.unshare.map((r) => r.relPath), ['d'])
  t.alike(Object.keys(s).sort(), ['bytes', 'count', 'download', 'hidden', 'onDevice', 'unshare'], 'a row under way counts, and no verb acts on it')
})

test('a key carrying the owner separates two owners\' same-named loose files', (t) => {
  const rows = [{ key: 'o1:/Brief.pdf', size: 1 }, { key: 'o2:/Brief.pdf', size: 2 }]
  const s = summarize({ rows, keyOf: (r) => r.key, sizeOf: (r) => r.size, selected: new Set(['o2:/Brief.pdf']), shown: new Set(), verbsOf: () => ({ download: true, inProgress: false, unshare: false, onDevice: false }) })
  t.is(s.count, 1)
  t.is(s.bytes, 2)
})
