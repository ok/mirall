import test from 'brittle'
import { WATCH_MODE, watchModeFor, settledAction, underPrefix } from '../../src/shared/folders/watch-derive.js'

test('U1 — the watch mode is chosen by the path first and the platform second', (t) => {
  t.is(watchModeFor('/Users/me/Shared', 'darwin'), WATCH_MODE.RECURSIVE)
  t.is(watchModeFor('C:\\Users\\me\\Shared', 'win32'), WATCH_MODE.RECURSIVE)
  t.is(watchModeFor('/home/me/Shared', 'linux'), WATCH_MODE.TREE)
  t.is(watchModeFor('/Volumes/NAS/Shared', 'darwin'), WATCH_MODE.POLL)
  t.is(watchModeFor('/mnt/nas/Shared', 'linux'), WATCH_MODE.POLL)
  t.is(watchModeFor('/media/usb/Shared', 'linux'), WATCH_MODE.POLL)
  t.is(watchModeFor('\\\\server\\share\\Shared', 'win32'), WATCH_MODE.POLL, 'UNC is platform-independent')
  t.is(watchModeFor('/Volumes/NAS/Shared', 'linux'), WATCH_MODE.TREE, '/Volumes is a darwin-only signal')
  t.is(watchModeFor('/mnt/nas/Shared', 'darwin'), WATCH_MODE.RECURSIVE, '/mnt is a linux-only signal')
})

test('U2 — the settled action comes from presence and whether the name appeared', (t) => {
  t.is(settledAction({ exists: true, sawRename: true }), 'add')
  t.is(settledAction({ exists: true, sawRename: false }), 'change')
  t.is(settledAction({ exists: false, sawRename: true }), 'unlink')
  t.is(settledAction({ exists: false, sawRename: false }), null, 'a change to a path that is gone is dropped')
})

test('U3 — a subtree prefix matches on a whole separator', (t) => {
  t.ok(underPrefix('/a/b/c', '/a/b', '/'))
  t.absent(underPrefix('/a/bb', '/a/b', '/'), 'a sibling is not a child')
  t.absent(underPrefix('/a/b', '/a/b', '/'), 'the prefix itself is not below itself')
  t.ok(underPrefix('C:\\a\\b\\c', 'C:\\a\\b', '\\'))
})
