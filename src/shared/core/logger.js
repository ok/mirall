// Leveled console logger with a `[module]` prefix. The level is re-read from runtime
// config on every call, so flipping `verbose` takes effect immediately: verbose ⇒
// debug and up, otherwise warnings + errors only.
import { getRuntimeConfig } from './runtime-config.js'

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }

function level() {
  const cfg = getRuntimeConfig()
  return cfg.verbose ? LOG_LEVELS.debug : LOG_LEVELS.warn
}

export function createLogger(module) {
  return {
    debug: (...args) => { if (level() <= 0) console.log(`[${module}]`, ...args) },
    info: (...args) => { if (level() <= 1) console.log(`[${module}]`, ...args) },
    warn: (...args) => { if (level() <= 2) console.warn(`[${module}]`, ...args) },
    error: (...args) => { if (level() <= 3) console.error(`[${module}]`, ...args) },
  }
}
