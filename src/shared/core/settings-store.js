// The worker's settings at rest: one settings.json beside the store, loaded once after the
// bootstrap and written through on every change. The worker is its only writer; main never reads
// it. A write that fails rejects the change and leaves memory as it was, so a caller told "saved"
// can rely on the next boot reading the same value. Writes are serialized: two overlapping changes
// each see the other's result rather than racing on one clone.
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import { writeFileAtomic } from './atomic-file.js'
import { coerceSettings, importFromConfig } from './settings-rules.js'
import { SETTINGS_FILE } from '../contract/settings-file.js'
import { sanitizeRelay } from '../network/relay-slot.js'
import { getRecentDownloadFolderLimit } from './runtime-config.js'
/** @import { Settings } from './settings-rules.js' */

const CONFIG_FILE = 'config.json'
const deps = () => ({ sanitizeRelay, recentLimit: getRecentDownloadFolderLimit() })
// The file is read before the runtime config exists, so the recent list keeps its whole length
// here and boot's hydrate (download-folder-choice.js) cuts it to the configured one.
const LOAD_DEPS = { sanitizeRelay, recentLimit: Infinity }

let current = null
let file = null
// Why the settings.json found at load could not be used; cleared once a write replaces it.
let broken = null
let queue = Promise.resolve()

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

// Three outcomes, kept apart: no file, a file that cannot be used, a file that can.
function readJson(p) {
  let raw
  try {
    raw = fs.readFileSync(p, 'utf-8')
  } catch (err) {
    return err?.code === 'ENOENT' ? { missing: true } : { broken: err?.message || String(err) }
  }
  try {
    const parsed = JSON.parse(raw)
    return isPlainObject(parsed) ? { value: parsed } : { broken: 'not a JSON object' }
  } catch (err) {
    return { broken: err?.message || String(err) }
  }
}

// Only a MISSING settings.json imports from config.json and writes the result: a file that exists
// but cannot be read is kept on disk and the worker runs on defaults until a change the user makes
// replaces it (updateSettings), since main may already have dropped the moved groups from
// config.json and an import would overwrite the user's settings with nothing.
/** @param {string} storagePath @returns {Promise<{ imported: boolean, persisted: boolean, broken: string | null }>} */
export async function loadSettings(storagePath) {
  const dataDir = path.dirname(storagePath)
  file = path.join(dataDir, SETTINGS_FILE)
  const stored = readJson(file)
  broken = stored.broken ?? null
  if (stored.value) {
    current = coerceSettings(stored.value, LOAD_DEPS)
    return { imported: false, persisted: true, broken: null }
  }
  if (stored.broken) {
    current = coerceSettings(null, LOAD_DEPS)
    return { imported: false, persisted: false, broken: stored.broken }
  }
  const config = readJson(path.join(dataDir, CONFIG_FILE))
  current = importFromConfig(config.value ?? null, LOAD_DEPS)
  try {
    await persist(current)
  } catch {
    return { imported: true, persisted: false, broken: null }
  }
  return { imported: true, persisted: true, broken: null }
}

/** @returns {Settings} */
export function getSettings() {
  if (!current) throw new Error('settings not loaded')
  return current
}

// Write first, then publish: a crash or a failed write leaves memory and disk agreeing on the
// previous value, and the caller sees the rejection. `keepBroken` marks the device's own
// bookkeeping (the recent download folders): while the file found at load is broken, such a change
// is held in memory, so the file is replaced only by a change the user makes.
/** @param {(s: Settings) => Settings} mutate @param {{ keepBroken?: boolean }} [opts] @returns {Promise<Settings>} */
export function updateSettings(mutate, { keepBroken = false } = {}) {
  const run = queue.then(async () => {
    const next = coerceSettings(mutate(structuredClone(getSettings())), deps())
    if (!keepBroken || broken === null) {
      await persist(next)
      broken = null
    }
    current = next
    return current
  })
  queue = run.catch(() => {})
  return run
}

async function persist(next) {
  await writeFileAtomic(file, b4a.from(JSON.stringify(next, null, 2)))
}

/** @internal */
export function _resetSettingsForTests() {
  current = null
  file = null
  broken = null
  queue = Promise.resolve()
}
