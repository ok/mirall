import test from 'brittle'
import { isFolderDrop, looksLikeFolderDrag, firstDirectoryName, inspectDragItems } from '../../src/renderer/dragShare.js'

// A DataTransferItemList-like fixture: each item exposes the three fields the
// heuristics read (kind, type, webkitGetAsEntry()).
const item = ({ kind = 'file', type = '', entry = null } = {}) => ({ kind, type, webkitGetAsEntry: () => entry })
const typedFile = (type = 'text/plain') => item({ kind: 'file', type })
const typelessFile = () => item({ kind: 'file', type: '' })
const dir = (name = 'Photos') => item({ kind: 'file', type: '', entry: { isDirectory: true, name } })
const fileEntry = () => item({ kind: 'file', type: 'image/png', entry: { isDirectory: false, name: 'a.png' } })

test('isFolderDrop: true iff some item resolves to a directory entry', (t) => {
  t.ok(isFolderDrop([dir('Docs')]))
  t.ok(isFolderDrop([fileEntry(), dir('Docs')]))
  t.absent(isFolderDrop([fileEntry()]))
  t.absent(isFolderDrop([typedFile(), typedFile()]))
})

test('looksLikeFolderDrag (dragover protected mode): lone typeless file item = folder', (t) => {
  t.ok(looksLikeFolderDrag([typelessFile()]))
  t.absent(looksLikeFolderDrag([typedFile('text/plain')]))
  t.absent(looksLikeFolderDrag([typelessFile(), typelessFile()]))
})

test('looksLikeFolderDrag: a real directory entry wins over the heuristic', (t) => {
  t.ok(looksLikeFolderDrag([fileEntry(), dir('Docs')]))
  t.absent(looksLikeFolderDrag([fileEntry(), fileEntry()]))
})

test('firstDirectoryName returns the first directory name or null', (t) => {
  t.is(firstDirectoryName([fileEntry(), dir('Photos')]), 'Photos')
  t.is(firstDirectoryName([typedFile()]), null)
})

test('inspectDragItems: files path reports the count', (t) => {
  t.alike(inspectDragItems([typedFile(), typedFile(), typedFile()]), { kind: 'files', count: 3, folderName: null })
})

test('inspectDragItems: folder path reports the name (null when entry not yet readable)', (t) => {
  t.alike(inspectDragItems([dir('Trip')]), { kind: 'folder', count: 0, folderName: 'Trip' })
  t.alike(inspectDragItems([typelessFile()]), { kind: 'folder', count: 0, folderName: null })
})
