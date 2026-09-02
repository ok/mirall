import test from 'brittle'
import { buildFileTree } from '../../src/renderer/fileTree.js'
import { filterTree } from '../../src/renderer/folderFilter.js'

function entry (relPath, extra = {}) {
  return { relPath, size: 10, hash: 'h', mtime: 0, status: 'remote', ...extra }
}

const FILES = [
  entry('Ninja Tune/01 Kruder & Dorfmeister.mp3'),
  entry('Ninja Tune/02 Bonobo.mp3'),
  entry('Boiler Room/Monika Kruse.mp3'),
  entry('readme.txt'),
]

function paths (nodes, out = []) {
  for (const node of nodes) {
    out.push(node.path)
    if (node.kind === 'folder') paths(node.children, out)
  }
  return out
}

test('an empty term is a pass-through', (t) => {
  const tree = buildFileTree(FILES)
  const result = filterTree(tree, '')
  t.is(result.nodes, tree, 'the same array, not a copy')
  t.is(result.matched, null, 'no count without a filter')
  t.is(result.revealPaths, null, 'the caller falls back to its own expansion')
})

test('whitespace only is also a pass-through', (t) => {
  const tree = buildFileTree(FILES)
  t.is(filterTree(tree, '   ').nodes, tree)
})

test('a file match keeps its ancestors and drops unrelated siblings', (t) => {
  const result = filterTree(buildFileTree(FILES), 'bonobo')
  t.is(result.matched, 1)
  t.alike(paths(result.nodes), ['Ninja Tune', 'Ninja Tune/02 Bonobo.mp3'], 'the branch that leads to the hit, and nothing else')
})

test('a folder match keeps its whole subtree without recursing into it', (t) => {
  const result = filterTree(buildFileTree(FILES), 'ninja')
  t.is(result.matched, 2, 'both tracks survive although neither name matches')
  t.alike(paths(result.nodes), ['Ninja Tune', 'Ninja Tune/01 Kruder & Dorfmeister.mp3', 'Ninja Tune/02 Bonobo.mp3'])
})

test('the match is case-insensitive and looks at the segment, not the whole path', (t) => {
  t.is(filterTree(buildFileTree(FILES), 'KRUDER').matched, 1, 'case folds')
  t.is(filterTree(buildFileTree(FILES), 'kruse').matched, 1, 'a leaf under another folder still matches')
  t.is(filterTree(buildFileTree(FILES), 'Tune/01').matched, 0, 'the separator is not part of any name')
})

test('no match returns an empty tree and a zero count', (t) => {
  const result = filterTree(buildFileTree(FILES), 'xyzzy')
  t.alike(result.nodes, [])
  t.is(result.matched, 0)
})

test('revealPaths holds every surviving folder and no files', (t) => {
  const result = filterTree(buildFileTree(FILES), 'kruder')
  t.alike([...result.revealPaths], ['Ninja Tune'], 'the ancestor is revealed')
  t.absent(result.revealPaths.has('Ninja Tune/01 Kruder & Dorfmeister.mp3'), 'files are not expandable')
})

test('a match set too large to reveal reports no reveal at all', (t) => {
  const many = []
  for (let i = 0; i < 300; i++) many.push(entry(`Deep/track ${i} echo.mp3`))
  const result = filterTree(buildFileTree(many), 'echo')
  t.is(result.matched, 300, 'still filtered')
  t.is(result.revealPaths, null, 'but the branches stay closed — this is the "typed one letter" case')
})

test('the input tree is never mutated', (t) => {
  const tree = buildFileTree(FILES)
  const before = paths(tree)
  filterTree(tree, 'bonobo')
  t.alike(paths(tree), before)
})

// The whole point of filtering in the renderer is that it is cheap enough to run per keystroke.
// The bar is deliberately loose (CI machines vary); it fails only if the shape goes non-linear.
test('filtering the largest admissible folder stays well under a frame', (t) => {
  const files = []
  for (let i = 0; i < 5000; i++) files.push(entry(`d${i % 50}/file ${i}.bin`))
  const tree = buildFileTree(files)
  const started = Date.now()
  for (let i = 0; i < 5; i++) filterTree(tree, 'file 4')
  const perRun = (Date.now() - started) / 5
  t.ok(perRun < 50, `5,000 rows filtered in ~${perRun}ms per keystroke`)
})
