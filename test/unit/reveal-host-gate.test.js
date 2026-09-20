import test from 'brittle'
import os from 'node:os'
import path from 'node:path'
import { loadWithFakeElectron } from '../helpers/fake-electron.js'

// The SECOND gate, independent of isRevealable. That one bounds where a client path may point;
// this one asks whose disk it is on at all — a question the home-jail cannot answer, because
// ~/Downloads/report.pdf is inside the jail on both machines.
function load() {
  const revealed = []
  const { electron, modules } = loadWithFakeElectron(['src/main/notifications.js'], {
    shell: { showItemInFolder: (p) => revealed.push(p) },
    Notification: class { constructor() {} static isSupported() { return false } on() {} show() {} },
    nativeImage: { createFromPath: () => null },
  })
  const [notifications] = modules
  notifications.register({ revealWindow: () => {}, downloadRoots: () => [] })
  return { handler: electron.ipcMain.handlers.get('shell:showInFolder'), revealed }
}

const HOME_FILE = path.join(os.homedir(), 'Downloads', 'report.pdf')

// REGRESSION (FIX-406-1: every absolute path on the wire meant "a path on the one machine
// everything runs on". event:transfer-complete carries a path the WORKER computed, and the
// notification click handed it straight to this machine's shell. Against a remote daemon that
// either does nothing or opens a coincidentally-existing local file of the same name — and the
// home jail cannot tell the difference, because the path is inside it either way.)
test('REGRESSION (FIX-406-1): a daemon path inside the home jail is refused', async (t) => {
  const { handler, revealed } = load()
  t.alike(await handler({}, { path: HOME_FILE, host: 'daemon' }), { ok: false })
  t.alike(revealed, [], 'the shell was never asked')
})

test('a client path inside the jail is revealed', async (t) => {
  const { handler, revealed } = load()
  t.alike(await handler({}, { path: HOME_FILE, host: 'client' }), { ok: true })
  t.alike(revealed, [path.resolve(HOME_FILE)])
})

test('a client path outside the jail is still refused — the two gates are independent', async (t) => {
  const { handler, revealed } = load()
  t.alike(await handler({}, { path: path.join(path.sep + 'etc', 'passwd'), host: 'client' }), { ok: false })
  t.alike(revealed, [])
})

test('a missing or unknown host is refused rather than guessed', async (t) => {
  const { handler, revealed } = load()
  for (const target of [{ path: HOME_FILE }, { path: HOME_FILE, host: 'remote' }, HOME_FILE, null, {}]) {
    t.alike(await handler({}, target), { ok: false }, `refused: ${JSON.stringify(target)}`)
  }
  t.alike(revealed, [], 'nothing reached the shell')
})
