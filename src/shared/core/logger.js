// Leveled console logger with a `[module]` prefix. The level is re-read from runtime
// config on every call, so flipping `verbose` takes effect immediately: verbose ⇒
// debug and up, otherwise warnings + errors only.
import { getRuntimeConfig } from './runtime-config.js'

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }

// Ordered key=value appended to the message, not JSON: the transport is a console line forwarded
// to main and read by a human with grep. Tagged with a symbol rather than recognised by shape, so
// the ~330 positional call sites that already log a plain object keep printing exactly as they do
// now. Symbol.for and not Symbol(): a module loaded through two specifiers would otherwise mint
// two tags, and a bag created under one would render as an object under the other.
const FIELDS = Symbol.for('mirall.logFields')

export function fields(bag) {
  return { [FIELDS]: bag }
}

function renderValue(value) {
  if (typeof value !== 'string') return value
  return value.includes(' ') || value === '' ? JSON.stringify(value) : value
}

function render(args) {
  const last = args[args.length - 1]
  if (!last || typeof last !== 'object' || !last[FIELDS]) return args
  const pairs = []
  for (const [key, value] of Object.entries(last[FIELDS])) {
    if (value === undefined || value === null) continue
    pairs.push(`${key}=${renderValue(value)}`)
  }
  const head = args.slice(0, -1)
  return pairs.length ? [...head, pairs.join(' ')] : head
}

function level() {
  const cfg = getRuntimeConfig()
  return cfg.verbose ? LOG_LEVELS.debug : LOG_LEVELS.warn
}

export function createLogger(module) {
  return {
    debug: (...args) => { if (level() <= 0) console.log(`[${module}]`, ...render(args)) },
    info: (...args) => { if (level() <= 1) console.log(`[${module}]`, ...render(args)) },
    warn: (...args) => { if (level() <= 2) console.warn(`[${module}]`, ...render(args)) },
    error: (...args) => { if (level() <= 3) console.error(`[${module}]`, ...render(args)) },
  }
}
