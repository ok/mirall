import test from 'brittle'
import { parentFolder, lastSegment } from '../../src/shared/contract/paths.js'

test('parentFolder: the folder a path sits in, a trailing separator ignored', (t) => {
  t.is(parentFolder('/home/ok/Downloads/a.pdf', '/'), '/home/ok/Downloads')
  t.is(parentFolder('/home/ok/Downloads/', '/'), '/home/ok')
  t.is(parentFolder('C:\\Users\\ok\\Downloads\\a.pdf', '\\'), 'C:\\Users\\ok\\Downloads')
  t.is(parentFolder('\\\\server\\share\\Press\\a.pdf', '\\'), '\\\\server\\share\\Press')
})

test('parentFolder: a filesystem root is its own folder, spelled as lastSegment names it', (t) => {
  t.is(parentFolder('/a.pdf', '/'), '/')
  t.is(parentFolder('/', '/'), '/')
  t.is(parentFolder('E:\\big.iso', '\\'), 'E:\\')
  t.is(parentFolder('E:\\', '\\'), 'E:\\')
  t.is(lastSegment(parentFolder('E:\\big.iso', '\\'), '\\'), 'E:\\', 'the menu and the row name the root alike')
})
