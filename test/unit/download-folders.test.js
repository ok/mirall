import test from 'brittle'
import { folderChoices, copyPlace, sameFolder, downloadsToShown } from '../../src/renderer/model/download-folders.js'

const MAC = { home: '/Users/olivera', sep: '/', caseFolds: true }
const LINUX = { home: '/home/ok', sep: '/', caseFolds: false }
const WIN = { home: 'C:\\Users\\ok', sep: '\\', caseFolds: true }

const paths = (list) => list.map((c) => c.path)

test('the space\'s folder leads, checked, then the recent folders in order', (t) => {
  const c = folderChoices({ current: '/Users/olivera/Nord', recent: ['/Users/olivera/Press', '/Users/olivera/Nord', '/Volumes/X/Clients'], unavailable: [], host: MAC })
  t.alike(paths(c), ['/Users/olivera/Nord', '/Users/olivera/Press', '/Volumes/X/Clients'])
  t.alike(c.map((x) => x.current), [true, false, false])
})

test('a recent folder equal to the current one appears once, folded only where the host folds', (t) => {
  t.alike(paths(folderChoices({ current: '/Users/olivera/Nord', recent: ['/users/olivera/NORD/', '/a'], unavailable: [], host: MAC })), ['/Users/olivera/Nord', '/a'])
  t.alike(paths(folderChoices({ current: '/home/ok/Nord', recent: ['/home/ok/nord', '/a'], unavailable: [], host: LINUX })), ['/home/ok/Nord', '/home/ok/nord', '/a'])
})

test('every recent folder follows the space\'s own: a current folder outside the list pushes none out', (t) => {
  const c = folderChoices({ current: '/x', recent: ['/a', '/b', '/c'], unavailable: [], host: LINUX })
  t.alike(paths(c), ['/x', '/a', '/b', '/c'])
  t.alike(paths(folderChoices({ current: '/x', recent: [], unavailable: [], host: LINUX })), ['/x'], 'an empty list gives the current folder alone')
})

// REGRESSION (FIX-DLTO-R20: the menu was capped at the recent list's length, so a fresh profile —
// one recent folder — whose space started in the folder for new spaces showed that folder alone).
test('REGRESSION (FIX-DLTO-R20: a fresh profile\'s only recent folder is offered beside the space\'s)', (t) => {
  const c = folderChoices({ current: '/Users/olivera/Mirall', recent: ['/Users/olivera/Downloads'], unavailable: [], host: MAC })
  t.alike(paths(c), ['/Users/olivera/Mirall', '/Users/olivera/Downloads'])
})

test('offline matches a folder exactly, never a folder that merely starts with its name', (t) => {
  const c = folderChoices({ current: '/Volumes/Archive', recent: ['/Volumes/Archive2', '/Volumes/Archive'], unavailable: ['/Volumes/Archive'], host: LINUX })
  t.alike(c.map((x) => [x.path, x.offline]), [['/Volumes/Archive', true], ['/Volumes/Archive2', false]])
})

test('a folder is named by its last segment and shown with home as ~', (t) => {
  const [c] = folderChoices({ current: '/Users/olivera/Projects/Nord Handover', recent: [], unavailable: [], host: MAC })
  t.is(c.name, 'Nord Handover')
  t.is(c.shown, '~/Projects/Nord Handover')
  const [sibling] = folderChoices({ current: '/Users/oliveraX/Files', recent: [], unavailable: [], host: MAC })
  t.is(sibling.shown, '/Users/oliveraX/Files', 'a name-prefix sibling of home is not under it')
  const [root] = folderChoices({ current: '/', recent: [], unavailable: [], host: LINUX })
  t.is(root.name, '/', 'the root names itself')
  const [win] = folderChoices({ current: 'C:\\Users\\ok\\Downloads\\', recent: [], unavailable: [], host: WIN })
  t.is(win.name, 'Downloads')
  t.is(win.shown, '~\\Downloads\\')
})

test('sameFolder ignores a trailing separator', (t) => {
  t.ok(sameFolder('/a/b/', '/a/b', LINUX))
  t.absent(sameFolder('/a/b', '/a/bc', LINUX))
})

test('copyPlace: a downloaded copy outside the space\'s folder says where it is', (t) => {
  t.alike(copyPlace({ status: 'downloaded', localPath: '/Users/olivera/Desktop/Press kit/a.pdf' }, '/Users/olivera/Nord', MAC), { kind: 'elsewhere', shown: '~/Desktop/Press kit' })
  t.is(copyPlace({ status: 'downloaded', localPath: '/Users/olivera/Nord/Share/sub/a.pdf' }, '/Users/olivera/Nord', MAC), null, 'inside the folder, at any depth, says nothing')
  t.is(copyPlace({ status: 'synced', localPath: '/elsewhere/a.pdf' }, '/Users/olivera/Nord', MAC), null, 'an own or mirrored copy says nothing')
  t.is(copyPlace({ status: 'remote', localPath: null }, '/x', MAC), null)
})

test('copyPlace: a copy on a drive that is not connected names its folder wherever it is', (t) => {
  t.alike(copyPlace({ status: 'detached', localPath: '/Volumes/Archive/Clients/a.pdf' }, '/Volumes/Archive/Clients', MAC), { kind: 'detached', shown: '/Volumes/Archive/Clients' })
})

test('Downloads to shows where something can be downloaded, and hides while selecting', (t) => {
  t.ok(downloadsToShown({ downloadable: true, selecting: false, offline: false }))
  t.absent(downloadsToShown({ downloadable: false, selecting: false, offline: false }), 'nothing to download, folder fine: no button')
  t.absent(downloadsToShown({ downloadable: true, selecting: true, offline: false }), 'the strip names the folder while selecting')
  t.absent(downloadsToShown({ downloadable: true, selecting: true, offline: true }))
})

// REGRESSION (FIX-DLTO-R14: the unreachable-folder toast's "Choose another folder" opened a space
// that listed no other member's file, and the one control that changes the folder was not there).
test('REGRESSION (FIX-DLTO-R14: an unreachable folder shows its button with nothing to download)', (t) => {
  t.ok(downloadsToShown({ downloadable: false, selecting: false, offline: true }))
  t.absent(downloadsToShown({ downloadable: false, selecting: false }), 'a folder screen gives no offline: an own or mirrored folder never offers it')
})

// REGRESSION (FIX-DLTO-R40: a copy at a drive's root read "Saved to E:", a name the menu never
// shows, beside "E:\" in the Download-to menu).
test('REGRESSION (FIX-DLTO-R40: a copy at a filesystem root names the root as the menu does)', (t) => {
  t.alike(copyPlace({ status: 'detached', localPath: 'E:\\big.iso' }, 'C:\\Users\\ok\\Downloads', WIN), { kind: 'detached', shown: 'E:\\' })
  t.alike(copyPlace({ status: 'downloaded', localPath: '/big.iso' }, '/home/ok/Downloads', LINUX), { kind: 'elsewhere', shown: '/' })
})

// REGRESSION (FIX-DLTO-R25: before the worker's settings answered, rows were judged with a made-up
// host — "/" separators, no home — so a Windows copy read "In /").
test('REGRESSION (FIX-DLTO-R25: no host path rules yet, no place said)', (t) => {
  t.is(copyPlace({ status: 'downloaded', localPath: 'C:\\Users\\ok\\Desktop\\a.pdf' }, 'C:\\Users\\ok\\Downloads', undefined), null)
  t.is(copyPlace({ status: 'detached', localPath: '/Volumes/Archive/a.pdf' }, '/Users/ok/Downloads', undefined), null)
})
