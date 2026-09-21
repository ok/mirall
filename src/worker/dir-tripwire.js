// DIAGNOSTIC — the data-directory tripwire, the Bare worker's half. The rule and the reasoning
// live in src/shared/core/dir-tripwire.js; this wraps bare-fs with it.
//
// The worker is where the data layer runs, so this is the half most likely to catch something:
// every corestore, hyperdrive and migration call reaches the disk through here. It logs to stdout
// rather than to a file — main pipes worker stdout into the log ring and the terminal, and the
// worker has no business writing outside its own storage.
import fs from 'bare-fs'
import path from 'bare-path'
import { classifyResolved, GUARDED_SYNC, GUARDED_ASYNC, pathArity } from '../shared/core/dir-tripwire.js'

let dataDir = null

/** Armed once the bootstrap frame lands: until then nothing is classified and nothing is refused. */
export function armDataDirTripwire(storagePath) {
  if (typeof storagePath !== 'string' || storagePath === '') return null
  dataDir = path.dirname(path.resolve(storagePath))
  return dataDir
}

function classify(target) {
  if (typeof target !== 'string' || !target || !dataDir) return null
  try {
    return classifyResolved(path.resolve(target), dataDir, path.sep)
  } catch {
    return null
  }
}

function record(name, kind, args) {
  const stack = new Error('data-dir tripwire').stack
  console.error([
    '=== MIRALL DATA-DIR TRIPWIRE ===',
    'when:    ' + new Date().toISOString(),
    'process: worker',
    'call:    fs.' + name + '(' + args.filter((a) => typeof a === 'string').join(', ') + ')',
    'kind:    ' + kind,
    stack,
  ].join('\n'))
}

/**
 * Installed at module load, before boot() constructs anything. `refuse` throwing inside the data
 * layer will almost certainly take the worker down — which is the point: a crash with a stack is
 * an answer, a silently destroyed profile is not.
 */
export function installDataDirTripwire({ refuse = true } = {}) {
  const tripped = (name, args) => {
    for (let i = 0; i < pathArity(name); i++) {
      const kind = classify(args[i])
      if (kind) return kind
    }
    return null
  }

  for (const name of GUARDED_SYNC) {
    if (typeof fs[name] !== 'function') continue
    const orig = fs[name].bind(fs)
    fs[name] = (...args) => {
      const kind = tripped(name, args)
      if (!kind) return orig(...args)
      record(name, kind, args)
      if (refuse) throw new Error('refused by data-dir tripwire: fs.' + name + ' on the ' + kind)
      return orig(...args)
    }
  }

  for (const name of GUARDED_ASYNC) {
    if (typeof fs[name] !== 'function') continue
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
    if (!fs.promises || typeof fs.promises[name] !== 'function') continue
    const origP = fs.promises[name].bind(fs.promises)
    fs.promises[name] = async (...args) => {
      const kind = tripped(name, args)
      if (!kind) return origP(...args)
      record(name, kind, args)
      if (refuse) throw new Error('refused by data-dir tripwire: fs.promises.' + name + ' on the ' + kind)
      return origP(...args)
    }
  }
}
