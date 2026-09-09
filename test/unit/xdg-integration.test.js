import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  integrateXdgLinux,
  desktopEntryFor,
  writeIfChanged,
  copyFileIfChanged,
} from '../../src/main/xdg-integration.js'

const MIME = 'x-scheme-handler/mirall'
const APPIMAGE = '/home/u/Applications/Mirall-1.10.1.AppImage'

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-xdg-'))
  t.teardown(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  return dir
}

// A recorder in place of child_process.spawn: the real one would fire desktop tooling at the
// developer's own session, and the arguments are the part worth asserting anyway.
function fakeSpawn() {
  const calls = []
  const spawn = (cmd, args) => {
    calls.push({ cmd, args })
    return { unref() {} }
  }
  return { spawn, calls }
}

test('Exec= is rewritten to the absolute AppImage path so a moved AppImage still launches', (t) => {
  const out = desktopEntryFor(
    '[Desktop Entry]\nName=Mirall\nExec=AppRun %U\nMimeType=x-scheme-handler/mirall;\n',
    { appimage: APPIMAGE, mimeToken: MIME },
  )
  t.ok(out.includes(`Exec="${APPIMAGE}" %U`), 'quoted, absolute, and keeps %U')
  t.absent(out.includes('Exec=AppRun'), 'the relative launcher is gone')
})

test('%U survives, because without it the desktop environment cannot hand us the URL at all', (t) => {
  const out = desktopEntryFor('[Desktop Entry]\nExec=AppRun\n', { appimage: APPIMAGE, mimeToken: MIME })
  t.ok(out.includes('%U'))
})

test('the scheme handler is appended to an existing MimeType= list without duplicating it', (t) => {
  const withOthers = desktopEntryFor(
    '[Desktop Entry]\nExec=x\nMimeType=inode/directory;text/plain;\n',
    { appimage: APPIMAGE, mimeToken: MIME },
  )
  t.is(withOthers.match(/^MimeType=(.*)$/m)[1], 'inode/directory;text/plain;x-scheme-handler/mirall;',
    'the entries that were already there are kept')

  const alreadyPresent = desktopEntryFor(
    '[Desktop Entry]\nExec=x\nMimeType=x-scheme-handler/mirall;\n',
    { appimage: APPIMAGE, mimeToken: MIME },
  )
  t.is(alreadyPresent.match(/x-scheme-handler\/mirall/g).length, 1, 're-running does not double it')
})

test('a desktop file with no MimeType= line gets one', (t) => {
  const out = desktopEntryFor('[Desktop Entry]\nName=Mirall\nExec=AppRun\n',
    { appimage: APPIMAGE, mimeToken: MIME })
  t.ok(/^MimeType=x-scheme-handler\/mirall;$/m.test(out))
})

test('rewriting is idempotent — a second pass over its own output changes nothing', (t) => {
  const once = desktopEntryFor('[Desktop Entry]\nExec=AppRun %U\nMimeType=inode/directory;\n',
    { appimage: APPIMAGE, mimeToken: MIME })
  t.is(desktopEntryFor(once, { appimage: APPIMAGE, mimeToken: MIME }), once)
})

test('writeIfChanged does not touch the file when the contents match', (t) => {
  // It exists so a relaunch does not churn the desktop entry's mtime, which is what makes some
  // desktop environments re-scan and flash the launcher.
  const dir = tmpdir(t)
  const file = path.join(dir, 'entry.desktop')

  writeIfChanged(file, 'hello')
  const first = fs.statSync(file).mtimeMs

  writeIfChanged(file, 'hello')
  t.is(fs.statSync(file).mtimeMs, first, 'untouched')

  writeIfChanged(file, 'goodbye')
  t.is(fs.readFileSync(file, 'utf8'), 'goodbye', 'but a real change is written')
})

test('writeIfChanged creates a file that is not there yet', (t) => {
  const file = path.join(tmpdir(t), 'new.desktop')
  writeIfChanged(file, 'contents')
  t.is(fs.readFileSync(file, 'utf8'), 'contents')
})

test('copyFileIfChanged is a no-op for an identical file and copies a changed one', (t) => {
  const dir = tmpdir(t)
  const src = path.join(dir, 'icon.png')
  const dest = path.join(dir, 'copy.png')
  fs.writeFileSync(src, 'aaaa')

  copyFileIfChanged(src, dest)
  t.is(fs.readFileSync(dest, 'utf8'), 'aaaa')
  const first = fs.statSync(dest).mtimeMs

  copyFileIfChanged(src, dest)
  t.is(fs.statSync(dest).mtimeMs, first, 'same size and no newer — skipped')

  fs.writeFileSync(src, 'bbbbbb')
  copyFileIfChanged(src, dest)
  t.is(fs.readFileSync(dest, 'utf8'), 'bbbbbb', 'a different size is copied')
})

test('integration is a no-op off Linux and without APPIMAGE/APPDIR', (t) => {
  const { spawn, calls } = fakeSpawn()
  const base = { appName: 'Mirall', protocol: 'mirall', homedir: tmpdir(t), spawn }

  t.absent(integrateXdgLinux({ ...base, isLinux: false, env: { APPIMAGE: 'x', APPDIR: 'y' } }),
    'not Linux')
  t.absent(integrateXdgLinux({ ...base, isLinux: true, env: {} }), 'Linux, but not an AppImage')
  t.absent(integrateXdgLinux({ ...base, isLinux: true, env: { APPIMAGE: 'x' } }), 'APPDIR missing')
  t.is(calls.length, 0, 'and nothing was spawned in any of those cases')
})

test('a run with no source .desktop in the AppDir does nothing rather than throwing', (t) => {
  const { spawn, calls } = fakeSpawn()
  t.absent(integrateXdgLinux({
    appName: 'Mirall',
    protocol: 'mirall',
    isLinux: true,
    homedir: tmpdir(t),
    env: { APPIMAGE: APPIMAGE, APPDIR: tmpdir(t) },
    spawn,
  }))
  t.is(calls.length, 0)
})

test('a full run writes the entry and the icons, then asks the desktop to pick them up', (t) => {
  const home = tmpdir(t)
  const appdir = tmpdir(t)
  fs.writeFileSync(path.join(appdir, 'Mirall.desktop'),
    '[Desktop Entry]\nName=Mirall\nExec=AppRun %U\n')
  for (const size of [48, 256]) {
    const iconDir = path.join(appdir, 'usr', 'share', 'icons', 'hicolor', `${size}x${size}`, 'apps')
    fs.mkdirSync(iconDir, { recursive: true })
    fs.writeFileSync(path.join(iconDir, 'Mirall.png'), `icon-${size}`)
  }

  const { spawn, calls } = fakeSpawn()
  t.ok(integrateXdgLinux({
    appName: 'Mirall',
    protocol: 'mirall',
    isLinux: true,
    homedir: home,
    env: { APPIMAGE: APPIMAGE, APPDIR: appdir },
    spawn,
  }))

  const written = fs.readFileSync(
    path.join(home, '.local', 'share', 'applications', 'Mirall.desktop'), 'utf8')
  t.ok(written.includes(`Exec="${APPIMAGE}" %U`))
  t.ok(written.includes(MIME))

  const icons = path.join(home, '.local', 'share', 'icons', 'hicolor')
  t.is(fs.readFileSync(path.join(icons, '48x48', 'apps', 'Mirall.png'), 'utf8'), 'icon-48')
  t.is(fs.readFileSync(path.join(icons, '256x256', 'apps', 'Mirall.png'), 'utf8'), 'icon-256')
  t.absent(fs.existsSync(path.join(icons, '128x128')), 'a size the AppDir does not carry is skipped')

  t.is(calls[0].cmd, 'update-desktop-database')
  t.is(calls[1].cmd, 'xdg-mime')
  t.alike(calls[1].args, ['default', 'Mirall.desktop', MIME])
})

test('a missing desktop tool costs the integration nothing', (t) => {
  const home = tmpdir(t)
  const appdir = tmpdir(t)
  fs.writeFileSync(path.join(appdir, 'Mirall.desktop'), '[Desktop Entry]\nExec=AppRun\n')

  t.ok(integrateXdgLinux({
    appName: 'Mirall',
    protocol: 'mirall',
    isLinux: true,
    homedir: home,
    env: { APPIMAGE: APPIMAGE, APPDIR: appdir },
    spawn: () => { throw new Error('ENOENT') },
  }), 'the entry is still written; the desktop picks it up on its next scan')
  t.ok(fs.existsSync(path.join(home, '.local', 'share', 'applications', 'Mirall.desktop')))
})
