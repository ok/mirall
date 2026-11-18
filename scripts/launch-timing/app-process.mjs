// Starting the app under measurement and making sure it is gone again. The app is started as the
// installed executable itself, not through the OS launcher, so the measurement owns its process and
// its stderr. Quitting is the app's own quit where the OS offers one from outside: SIGTERM on macOS
// and Linux runs Electron's before-quit, which stops the back end. Windows has no such signal, so
// the main process is ended and the back end exits on its own when its spawn pipe closes.
import { execFile } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * The executable and the arguments that come before the app's own flags.
 * @param {{ app?: string, source?: string }} target
 * @returns {{ file: string, prefix: string[] }}
 */
export function resolveLaunch({ app, source }) {
  if (source) {
    const repo = path.resolve(source)
    // The electron package's main export is the path of its binary.
    const electron = createRequire(path.join(repo, 'package.json'))('electron')
    return { file: electron, prefix: [repo] }
  }
  const target = path.resolve(app)
  if (target.endsWith('.app') && statSync(target).isDirectory()) {
    const dir = path.join(target, 'Contents', 'MacOS')
    const entries = readdirSync(dir)
    if (entries.length !== 1) throw new Error(`expected one executable in ${dir}, found ${entries.length}`)
    return { file: path.join(dir, entries[0]), prefix: [] }
  }
  return { file: target, prefix: [] }
}

/**
 * Every pid reachable from `root` through parent links, root included.
 * @param {{ pid: number, ppid: number }[]} processes
 * @param {number} root
 * @returns {number[]}
 */
export function descendantsOf(processes, root) {
  const children = new Map()
  for (const { pid, ppid } of processes) {
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  const found = new Set([root])
  const queue = [root]
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (found.has(child)) continue
      found.add(child)
      queue.push(child)
    }
  }
  return [...found]
}

/** @param {string} text @returns {{ pid: number, ppid: number }[]} */
export function parseProcessTable(text) {
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (Number.isInteger(pid) && Number.isInteger(ppid)) rows.push({ pid, ppid })
  }
  return rows
}

/** @returns {Promise<{ pid: number, ppid: number }[]>} */
export async function listProcesses() {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 16 << 20 })
    return parseProcessTable(stdout)
  }
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid='], { maxBuffer: 16 << 20 })
  return parseProcessTable(stdout)
}

/** @param {number[]} pids @returns {Promise<number[]>} the ones still running */
export async function stillRunning(pids) {
  const live = new Set((await listProcesses()).map((p) => p.pid))
  return pids.filter((pid) => live.has(pid))
}

/** @param {number} pid */
export async function requestQuit(pid) {
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/F']).catch(() => {})
    return
  }
  try { process.kill(pid, 'SIGTERM') } catch {}
}

/** @param {number[]} pids */
export async function forceKill(pids) {
  for (const pid of pids) {
    if (process.platform === 'win32') await run('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => {})
    else try { process.kill(pid, 'SIGKILL') } catch {}
  }
}
