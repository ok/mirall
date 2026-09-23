import test from 'brittle'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { linuxInstallKind, updatesOffReason, DEB_INSTALL_ROOT } = require('../../src/main/install-kind.js')
const pkg = require('../../package.json')

const DEB_EXEC = DEB_INSTALL_ROOT + 'Mirall'
const packaged = (env, execPath) => linuxInstallKind({ isLinux: true, isPackaged: true, env, execPath })

test('the deb install root is /usr/lib/<package name>/, the tree the maker installs to', (t) => {
  t.is(DEB_INSTALL_ROOT, `/usr/lib/${pkg.name}/`)
})

test('APPIMAGE set on a packaged Linux build is an AppImage wherever execPath points', (t) => {
  t.is(packaged({ APPIMAGE: '/home/u/Mirall.AppImage' }, '/tmp/.mount_x/Mirall'), 'appimage')
  t.is(packaged({ APPIMAGE: '/x' }, DEB_EXEC), 'appimage', 'APPIMAGE wins over the path')
})

test('a packaged Linux build under the deb root with no APPIMAGE is a deb', (t) => {
  t.is(packaged({}, DEB_EXEC), 'deb')
  t.is(packaged({ APPIMAGE: '' }, DEB_EXEC), 'deb', 'an empty APPIMAGE is unset')
})

test('a packaged Linux build anywhere else is unpacked, never mistaken for a deb', (t) => {
  for (const p of [
    '/home/u/mirall/out/Mirall-linux-x64/Mirall',
    '/opt/Mirall/Mirall',
    '/usr/lib/mirall-old/Mirall',
    '/usr/local/lib/mirall/Mirall',
  ]) {
    t.is(packaged({}, p), 'unpacked', p)
  }
})

test('off Linux, or unpackaged, the kind is none', (t) => {
  t.is(linuxInstallKind({ isLinux: false, isPackaged: true, env: {}, execPath: DEB_EXEC }), 'none')
  t.is(linuxInstallKind({ isLinux: true, isPackaged: false, env: {}, execPath: DEB_EXEC }), 'none')
})

test('env and execPath default to the running process', (t) => {
  t.ok(['appimage', 'deb', 'unpacked'].includes(linuxInstallKind({ isLinux: true, isPackaged: true })))
})

test('updates are off on a deb install first, then under --no-updates, then without an upgrade key', (t) => {
  const on = { installKind: 'appimage', updatesFlag: undefined, upgrade: 'pear://key' }
  t.is(updatesOffReason(on), null, 'a keyed AppImage build updates')
  t.is(updatesOffReason({ ...on, installKind: 'none' }), null, 'macOS / Windows update')
  t.is(updatesOffReason({ ...on, installKind: 'deb' }), 'deb-install')
  t.is(updatesOffReason({ ...on, installKind: 'deb', updatesFlag: false, upgrade: undefined }), 'deb-install', 'the install kind outranks the flag')
  t.is(updatesOffReason({ ...on, updatesFlag: false }), 'flag')
  t.is(updatesOffReason({ ...on, updatesFlag: false, upgrade: undefined }), 'flag', 'the flag outranks a missing key')
  t.is(updatesOffReason({ ...on, upgrade: undefined }), 'no-upgrade-key')
  t.is(updatesOffReason({ ...on, installKind: 'unpacked' }), null, 'an unpacked tree is not a deb')
})
