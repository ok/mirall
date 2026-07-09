import test from 'brittle'
import {
  buildFileTree, collectFolderPaths, topLevelFolderPaths, statusCategory
} from '../../src/renderer/fileTree.js'

const f = (relPath, size = 0, status = 'remote') => ({ relPath, size, status, hash: '', mtime: 0 })

test('empty input → empty tree', (t) => {
  t.alike(buildFileTree([]), [])
  t.alike(buildFileTree(undefined), [])
})

test('flat files (no slashes) → file nodes only, sorted, no folders', (t) => {
  const tree = buildFileTree([f('b.txt'), f('a.txt')])
  t.is(tree.length, 2)
  t.is(tree[0].kind, 'file')
  t.alike(tree.map((n) => n.name), ['a.txt', 'b.txt'])
  t.is(collectFolderPaths(tree).length, 0)
})

test('nested paths build folders; basenames + depth + paths are correct', (t) => {
  const tree = buildFileTree([f('Brand/Logos/logo.svg', 10)])
  t.is(tree.length, 1)
  const brand = tree[0]
  t.is(brand.kind, 'folder'); t.is(brand.name, 'Brand'); t.is(brand.path, 'Brand'); t.is(brand.depth, 0)
  const logos = brand.children[0]
  t.is(logos.name, 'Logos'); t.is(logos.path, 'Brand/Logos'); t.is(logos.depth, 1)
  const file = logos.children[0]
  t.is(file.kind, 'file'); t.is(file.name, 'logo.svg'); t.is(file.path, 'Brand/Logos/logo.svg'); t.is(file.depth, 2)
})

test('folder aggregates roll up the whole subtree', (t) => {
  const tree = buildFileTree([
    f('Brand/Logos/a.svg', 100, 'downloaded'),
    f('Brand/Logos/b.svg', 200, 'downloaded'),
    f('Brand/Photos/c.jpg', 700, 'downloading')
  ])
  const brand = tree[0]
  t.is(brand.fileCount, 3)
  t.is(brand.totalBytes, 1000)
  t.is(brand.folderCount, 2)
  t.is(brand.statusCounts['on-device'], 2)
  t.is(brand.statusCounts.downloading, 1)
})

test('statusCategory maps every ShareFileStatus member', (t) => {
  t.is(statusCategory('downloaded'), 'on-device')
  t.is(statusCategory('synced'), 'on-device')
  t.is(statusCategory('downloading'), 'downloading')
  t.is(statusCategory('preparing'), 'downloading')
  t.is(statusCategory('verifying'), 'downloading')
  t.is(statusCategory('paused-interrupted'), 'paused')
  t.is(statusCategory('paused-offline'), 'paused')
  t.is(statusCategory('error'), 'error')
  t.is(statusCategory('remote'), 'available')
  t.is(statusCategory('unavailable'), 'available')
})

test('folders sort before files; names sort alphanumeric, case-insensitive', (t) => {
  const tree = buildFileTree([f('z.txt'), f('file10.txt'), f('file2.txt'), f('Apples/x.txt')])
  t.is(tree[0].kind, 'folder')
  t.is(tree[0].name, 'Apples')
  t.alike(tree.slice(1).map((n) => n.name), ['file2.txt', 'file10.txt', 'z.txt'])
})

test('backslash + leading/trailing slashes are normalized', (t) => {
  const tree = buildFileTree([f('Brand\\Logos\\a.svg'), f('/Brand/Logos/b.svg')])
  t.is(tree[0].name, 'Brand')
  t.is(tree[0].children[0].name, 'Logos')
  t.is(tree[0].children[0].fileCount, 2)
})

test('deep single file builds a folder per level', (t) => {
  const tree = buildFileTree([f('a/b/c/d.txt')])
  let node = tree[0]
  let depth = 0
  while (node.kind === 'folder') { t.is(node.depth, depth++); node = node.children[0] }
  t.is(node.name, 'd.txt'); t.is(node.depth, 3)
})

test('collectFolderPaths / topLevelFolderPaths', (t) => {
  const tree = buildFileTree([f('A/B/x.txt'), f('A/y.txt'), f('z.txt')])
  t.alike(collectFolderPaths(tree).sort(), ['A', 'A/B'])
  t.alike(topLevelFolderPaths(tree), ['A'])
})

test('entries with empty/invalid relPath are skipped', (t) => {
  const tree = buildFileTree([f(''), f('/'), { size: 1, status: 'remote' }, f('ok.txt')])
  t.is(tree.length, 1)
  t.is(tree[0].name, 'ok.txt')
})
