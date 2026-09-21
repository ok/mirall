// DIAGNOSTIC — the data-directory tripwire, Electron main's half. See
// src/shared/core/dir-tripwire.js for why this exists.
//
// `classifyResolved` is duplicated from that module rather than imported: main is CJS and must
// install this during boot, synchronously, before anything can call fs — and a dynamic import of
// the ESM original resolves a tick too late. test/unit/dir-tripwire.test.js runs BOTH copies
// against one table of cases, so they cannot drift apart silently.
//
// Patching the module object works even for modules that already required fs, because a call site
// reads `fs.rm` at call time. The exception is a module that destructured (`const { rm } =
// require('fs')`) before install; nothing we control does, and the worker half covers the data
// layer, but a miss there is the one blind spot worth remembering when reading a clean result.

const fs = require('fs')
const path = require('path')
const os = require('os')

const STORE_DIR = 'app-storage'
// Outside the profile on purpose: a log written INTO the directory being destroyed is no evidence.
const LOG_FILE = path.join(os.homedir(), 'mirall-tripwire.log')

function trimTrailing(p, sep) {
  let end = p.length
  while (end > 1 && p[end - 1] === sep) end--
  return p.slice(0, end)
}

function classifyResolved(target, dataDir, sep = path.sep) {
  if (typeof target !== 'string' || typeof dataDir !== 'string') return null
  if (target === '' || dataDir === '') return null
  const t = trimTrailing(target, sep)
  const d = trimTrailing(dataDir, sep)
  if (t === d) return 'data-dir'
  // The POSIX root trims to "/" rather than "", so the prefix test below would compare against
  // "//" and miss it. Every absolute path is inside the root by definition.
  if (t === sep) return 'ancestor'
  if (d.startsWith(t + sep)) return 'ancestor'
  if (t === d + sep + STORE_DIR) return 'store'
  return null
}

function classify(target, dataDir) {
  if (typeof target !== 'string' || !target) return null
  if (typeof dataDir !== 'string' || !dataDir) return null
  // Resolve first: `rm(path.join(dir, '..'))` reaches fs as an unresolved string, and comparing it
  // raw would miss exactly the call we are hunting.
  try {
    return classifyResolved(path.resolve(target), path.resolve(dataDir), path.sep)
  } catch {
    return null
  }
}

function record(name, kind, args) {
  const stack = new Error('data-dir tripwire').stack
  const entry = [
    '=== MIRALL DATA-DIR TRIPWIRE ===',
    'when:   ' + new Date().toISOString(),
    'process: main',
    'call:   fs.' + name + '(' + args.filter((a) => typeof a === 'string').join(', ') + ')',
    'kind:   ' + kind,
    stack,
    '',
  ].join('\n')
  // Both, deliberately: the console goes to the log ring and the terminal, the file survives the
  // process dying — and a call that destroys the profile may well be followed by a crash.
  console.error(entry)
  try { fs.appendFileSync(LOG_FILE, entry + '\n') } catch {}
}

/**
 * Wrap the destructive fs calls. `getDataDir` is read per call rather than captured: main resolves
 * the profile path after argv parsing (--storage moves it), and the guard has to be armed before
 * that without knowing the answer yet. An unset dir classifies as null and nothing is refused.
 */
function installDataDirTripwire({ getDataDir, refuse = process.env.MIRALL_TRIPWIRE_ALLOW !== '1' } = {}) {
  const sync = ['rmSync', 'rmdirSync', 'unlinkSync', 'renameSync']
  const async_ = ['rm', 'rmdir', 'unlink', 'rename']
  const arity = (name) => (name.startsWith('rename') ? 2 : 1)

  const tripped = (name, args) => {
    let dataDir = null
    try { dataDir = getDataDir() } catch { return null }
    for (let i = 0; i < arity(name); i++) {
      const kind = classify(args[i], dataDir)
      if (kind) return kind
    }
    return null
  }

  for (const name of sync) {
    const orig = fs[name].bind(fs)
    fs[name] = (...args) => {
      const kind = tripped(name, args)
      if (!kind) return orig(...args)
      record(name, kind, args)
      if (refuse) throw new Error('refused by data-dir tripwire: fs.' + name + ' on the ' + kind)
      return orig(...args)
    }
  }

  for (const name of async_) {
    const orig = fs[name].bind(fs)
    fs[name] = (...args) => {
      const kind = tripped(name, args)
      if (!kind) return orig(...args)
      record(name, kind, args)
      const cb = args[args.length - 1]
      if (!refuse) return orig(...args)
      const err = new Error('refused by data-dir tripwire: fs.' + name + ' on the ' + kind)
      if (typeof cb === 'function') return cb(err)
      throw err
    }
    const origP = fs.promises[name] ? fs.promises[name].bind(fs.promises) : null
    if (!origP) continue
    fs.promises[name] = async (...args) => {
      const kind = tripped(name, args)
      if (!kind) return origP(...args)
      record(name, kind, args)
      if (refuse) throw new Error('refused by data-dir tripwire: fs.promises.' + name + ' on the ' + kind)
      return origP(...args)
    }
  }

  // renameat2(RENAME_EXCHANGE) is the one way to replace a directory entry — and therefore change
  // its birth time — in a single syscall, which is exactly the signature we cannot otherwise tell
  // apart from a delete. It is native, so the JS export is the only place to catch it.
  try {
    const fsx = require('fs-native-extensions')
    if (typeof fsx.swap === 'function') {
      const origSwap = fsx.swap.bind(fsx)
      fsx.swap = async (a, b) => {
        const kind = tripped('rename', [a, b])
        if (!kind) return origSwap(a, b)
        record('fsx.swap', kind, [a, b])
        if (refuse) throw new Error('refused by data-dir tripwire: fsx.swap on the ' + kind)
        return origSwap(a, b)
      }
    }
  } catch {}

  return { logFile: LOG_FILE }
}

// test seam: classifyResolved is exported for the twin test only.
module.exports = { installDataDirTripwire, classifyResolved, LOG_FILE }
