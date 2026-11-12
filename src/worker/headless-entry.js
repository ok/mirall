// What the worker entry does differently when nothing spawned it: no fd 3, so `Bare.IPC` is null and
// no host sends a bootstrap. The command line stands in for it (headless-args.js), the data folder
// is created owner-only the way the desktop app hardens it on POSIX, and the socket's path goes to
// stdout as the frame a host would have been sent, so whoever started the process can wait for it.
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import Signal from 'bare-signals'
import { headlessBootstrap, USAGE } from './headless-args.js'
import { MAIN_REQUEST_FRAME, MAIN_REQUEST } from '../shared/contract/main-requests.js'

const ENV_READ = ['XDG_CONFIG_HOME', 'APPDATA', 'MIRALL_VERBOSE']

/** @param {string} packageRoot @returns {{ bootstrap: Record<string, unknown> } | { refusal: string }} */
export function readHeadlessBootstrap(packageRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  const env = Object.fromEntries(ENV_READ.map((key) => [key, os.hasEnv(key) ? os.getEnv(key) : undefined]))
  const out = headlessBootstrap({ argv: Bare.argv.slice(2), env, platform: os.platform(), homedir: os.homedir(), pkg })
  if ('refusal' in out) return out
  return { bootstrap: { ...out.bootstrap, storage: path.resolve(String(out.bootstrap.storage)) } }
}

/** @param {string} refusal */
export function printUsage(refusal) {
  if (refusal === 'help') console.log(USAGE)
  else console.error(refusal + '\n' + USAGE)
}

// Only a folder this start creates: an existing profile keeps the modes its owner gave it. Windows
// has no mode, and its ACL hardening is the desktop app's alone.
/** @param {string} storage */
export function prepareStorageDir(storage) {
  if (fs.existsSync(storage)) return
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 })
  if (os.platform() !== 'win32') fs.chmodSync(storage, 0o700)
}

/** @param {string} socketPath */
export function announceListening(socketPath) {
  console.log(JSON.stringify({ type: MAIN_REQUEST_FRAME, command: MAIN_REQUEST.SOCKET_LISTENING, args: { path: socketPath } }))
}

// The sidecar build of bare — the one the desktop app ships — opens fd 3 as its host pipe whatever
// is there, and exits when that pipe closes. Started from a command line, the pipe is nobody's: it is
// closed here, with listeners that keep its close from ending the process.
/** @param {{ on: Function, destroy: Function } | null} pipe */
export function releaseUnusedPipe(pipe) {
  if (!pipe) return
  pipe.on('error', () => {})
  pipe.on('close', () => {})
  pipe.destroy()
}

// Nobody quits a headless worker through a window, so the terminal and the service manager stop it
// the way they stop any process: SIGTERM and SIGINT (Ctrl+C, on Windows too), and SIGBREAK
// (Ctrl+Break) where Windows has it. Unref'd: a handler alone never keeps the worker alive.
/** @param {(signal: string) => void} stop */
export function installStopSignals(stop) {
  const names = os.platform() === 'win32' ? ['SIGINT', 'SIGBREAK'] : ['SIGTERM', 'SIGINT']
  for (const name of names) {
    if (!(name in Signal.constants)) continue
    const signal = new Signal(name)
    signal.on('signal', () => stop(name))
    signal.start()
    signal.unref()
  }
}
