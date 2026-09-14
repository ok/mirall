import { readdirSync } from 'node:fs'
import path from 'node:path'

// The directory IS the registry. run.mjs carried 134 import lines and a 135-key table beside a
// readdirSync of this same folder — two spellings of one list, and adding a scenario meant editing
// both. Numeric sort so s9 runs before s10; the listing order is the run order.
export const SCENARIOS = readdirSync(import.meta.dirname)
  .filter((f) => /^s\d+-.*\.mjs$/.test(f))
  .map((file) => ({ key: file.split('-')[0], slug: file.replace(/\.mjs$/, ''), file }))
  .sort((a, b) => Number(a.key.slice(1)) - Number(b.key.slice(1)))

export async function load(key) {
  const entry = SCENARIOS.find((s) => s.key === key)
  if (!entry) throw new Error(`no scenario ${key} (have ${SCENARIOS.length})`)
  return (await import(path.join(import.meta.dirname, entry.file))).default
}
