import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const CONFIG = require.resolve('../../forge.config.js')

// forge.config.js reads the environment at module scope; it is swapped wholesale so a developer's
// APPLE_* cannot leak in, and the module cache is cleared on both sides of the load.
export function loadConfig(env = { UPGRADE_KEY: 'none' }) {
  const saved = process.env
  process.env = env
  try {
    delete require.cache[CONFIG]
    return require(CONFIG)
  } finally {
    process.env = saved
    delete require.cache[CONFIG]
  }
}
