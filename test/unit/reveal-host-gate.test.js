import test from 'brittle'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadWithFakeElectron } from '../helpers/fake-electron.js'
import { CODES } from '../../src/shared/contract/errors.js'
import { PATH_HOST } from '../../src/shared/contract/paths.js'

// The SECOND gate, independent of isRevealable. That one bounds where a path may point; this one
// asks whose disk it is on at all — a question the home-jail cannot answer, because
// ~/Downloads/report.pdf is inside the jail on both machines. The worker answers a reveal with a
// path tagged as its own, so the gate admits a daemon path exactly when main knows the daemon this
// window talks to is this machine: the worker is one this process spawned.
const LOCAL_WINDOW = 7
const REMOTE_WINDOW = 8

function load({ workerIsLocal = (id) => id === LOCAL_WINDOW, roots = () => [] } = {}) {
  const revealed = []
  const { electron, modules } = loadWithFakeElectron(['src/main/notifications.js'], {
    shell: { showItemInFolder: (p) => revealed.push(p), openPath: async () => { throw new Error('the gate never opens, only shows') } },
    Notification: class { constructor() {} static isSupported() { return false } on() {} show() {} },
    nativeImage: { createFromPath: () => null },
  })
  const [notifications] = modules
  notifications.register({ revealWindow: () => {}, revealRoots: roots, workerIsLocal })
  const handler = electron.ipcMain.handlers.get('shell:showInFolder')
  return { reveal: (target, windowId = LOCAL_WINDOW) => handler({ sender: { id: windowId } }, target), revealed }
}

// Real files: main reads the disk itself rather than taking the caller's word for what is there.
function diskRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reveal-gate-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  return fs.realpathSync(root)
}

const HOME_FILE = path.join(os.homedir(), 'Downloads', 'report.pdf')
const REFUSED = { ok: false, code: CODES.REVEAL_REFUSED }

// REGRESSION (FIX-406-1: every absolute path on the wire meant "a path on the one machine
// everything runs on", and a notification click handed a worker-computed path straight to this
// machine's shell. When main did not spawn the worker this window talks to, it cannot vouch for
// that disk being this one, and the path stays closed even inside the home jail.)
test('REGRESSION (FIX-406-1): a daemon path is refused while the worker is not known local', async (t) => {
  const { reveal, revealed } = load({ workerIsLocal: () => false })
  t.alike(await reveal({ path: HOME_FILE, host: PATH_HOST.DAEMON }), REFUSED)
  t.alike(revealed, [], 'the shell was never asked')
})

test('a daemon path is revealed for the window whose worker this process spawned', async (t) => {
  const root = diskRoot(t)
  const file = path.join(root, 'report.pdf')
  fs.writeFileSync(file, 'x')
  const { reveal, revealed } = load({ roots: () => [root] })
  t.alike(await reveal({ path: file, host: PATH_HOST.DAEMON }, LOCAL_WINDOW), { ok: true })
  t.alike(revealed, [file])
  t.alike(await reveal({ path: file, host: PATH_HOST.DAEMON }, REMOTE_WINDOW), REFUSED,
    'the same path from a window on a worker main did not spawn is refused')
  t.alike(revealed, [file])
})

test('a client path inside the jail is revealed whatever main knows about the worker', async (t) => {
  const root = diskRoot(t)
  const file = path.join(root, 'report.pdf')
  fs.writeFileSync(file, 'x')
  const { reveal, revealed } = load({ workerIsLocal: () => false, roots: () => [root] })
  t.alike(await reveal({ path: file, host: PATH_HOST.CLIENT }), { ok: true })
  t.alike(revealed, [file])
})

test('a daemon path outside the jail is still refused — the two gates are independent', async (t) => {
  const { reveal, revealed } = load()
  t.alike(await reveal({ path: path.join(path.sep + 'etc', 'passwd'), host: PATH_HOST.DAEMON }), REFUSED)
  t.alike(revealed, [])
})

test('a missing file is shown by its folder, and the folder is what the allowlist checks', async (t) => {
  const root = diskRoot(t)
  const inside = path.join(root, 'Projects')
  fs.mkdirSync(inside)
  const { reveal, revealed } = load({ roots: () => [inside] })
  t.alike(await reveal({ path: path.join(inside, 'gone.bin'), host: PATH_HOST.DAEMON }), { ok: true })
  t.alike(revealed, [inside], 'the folder is shown')
  t.alike(await reveal({ path: path.join(root, 'nope', 'gone.bin'), host: PATH_HOST.DAEMON }), REFUSED,
    'a folder that is not there is not shown')
  t.alike(await reveal({ path: inside, host: PATH_HOST.DAEMON, exists: true }), { ok: true }, 'a folder that is a root is shown')
})

test('a missing target whose folder lies outside every root is refused', async (t) => {
  const root = diskRoot(t)
  const inside = path.join(root, 'Projects')
  fs.mkdirSync(inside)
  const { reveal, revealed } = load({ roots: () => [inside] })
  t.alike(await reveal({ path: path.join(root, 'elsewhere.bin'), host: PATH_HOST.DAEMON }), REFUSED,
    'its folder is the root’s parent, which is not allowlisted')
  t.alike(revealed, [])
})

// The caller's word about the disk is not evidence. The gate reads the disk itself and only ever
// SHOWS a path, so a bundle inside the jail cannot be launched by claiming its contents are missing.
test('what is on disk is main’s own reading, never the caller’s exists flag', async (t) => {
  const root = diskRoot(t)
  const bundle = path.join(root, 'Evil.app')
  fs.mkdirSync(bundle)
  const { reveal, revealed } = load({ roots: () => [root] })
  t.alike(await reveal({ path: path.join(bundle, 'Contents'), host: PATH_HOST.CLIENT, exists: false }), { ok: true })
  t.alike(revealed, [bundle], 'shown in its folder, not opened')
  const file = path.join(root, 'present.bin')
  fs.writeFileSync(file, 'x')
  t.alike(await reveal({ path: file, host: PATH_HOST.CLIENT, exists: false }), { ok: true })
  t.alike(revealed, [bundle, file], 'a file that is there is shown itself, whatever the caller said')
})

test('a missing or unknown host is refused rather than guessed', async (t) => {
  const { reveal, revealed } = load()
  for (const target of [{ path: HOME_FILE }, { path: HOME_FILE, host: 'remote' }, HOME_FILE, null, {}]) {
    t.alike(await reveal(target), REFUSED, `refused: ${JSON.stringify(target)}`)
  }
  t.alike(revealed, [], 'nothing reached the shell')
})
