// scripts/export-translations.mjs — export i18n strings to CSV for review.
//
// Reads src/renderer/locales/<lang>/<ns>.json and emits a flattened table:
//   namespace, key, en, de, fr, es, it
//
// Usage:
//   node scripts/export-translations.mjs [--out <file-or-dir>] [--langs en,de,fr]
//
// Defaults: --out ./translations.csv  --langs en,de,fr,es,it
// Namespaces are auto-discovered from src/renderer/locales/<first-lang>/.

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..')
const LOCALES_DIR = join(PROJECT_ROOT, 'src', 'renderer', 'locales')

function parseArgs (argv) {
  const args = { out: null, langs: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--out' || a === '-o') args.out = argv[++i]
    else if (a === '--langs' || a === '-l') args.langs = argv[++i]
    else throw new Error(`Unknown argument: ${a}`)
  }
  return args
}

function usage () {
  console.log(`Usage: node scripts/export-translations.mjs [--out <file-or-dir>] [--langs en,de,fr]

Options:
  -o, --out <path>     Output CSV path. If a directory, writes translations.csv inside.
                       Default: ./translations.csv (relative to project root)
  -l, --langs <list>   Comma-separated language codes, in column order.
                       Default: en,de,fr,es,it (auto-detected codes that exist)
  -h, --help           Show this help.`)
}

function flatten (obj, prefix = '') {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key))
    else out[key] = v
  }
  return out
}

function loadNs (lang, ns) {
  return flatten(JSON.parse(readFileSync(join(LOCALES_DIR, lang, `${ns}.json`), 'utf8')))
}

function csvCell (v) {
  if (v === undefined || v === null) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function resolveOutputPath (out) {
  const fallback = join(PROJECT_ROOT, 'translations.csv')
  if (!out) return fallback
  const abs = resolve(process.cwd(), out)
  let isDir = false
  try { isDir = statSync(abs).isDirectory() } catch {}
  return isDir ? join(abs, 'translations.csv') : abs
}

const args = parseArgs(process.argv.slice(2))
if (args.help) { usage(); process.exit(0) }

const availableLangs = readdirSync(LOCALES_DIR).filter(d => statSync(join(LOCALES_DIR, d)).isDirectory())
const requestedLangs = args.langs
  ? args.langs.split(',').map(s => s.trim()).filter(Boolean)
  : ['en', 'de', 'fr', 'es', 'it']
const langs = requestedLangs.filter(l => availableLangs.includes(l))
const missing = requestedLangs.filter(l => !availableLangs.includes(l))
if (missing.length) console.warn(`warning: skipping missing languages: ${missing.join(', ')}`)
if (!langs.length) { console.error(`error: no requested languages found in ${LOCALES_DIR}`); process.exit(1) }

const namespaces = readdirSync(join(LOCALES_DIR, langs[0]))
  .filter(f => f.endsWith('.json'))
  .map(f => basename(f, '.json'))
  .sort()

const tables = {}
for (const ns of namespaces) {
  tables[ns] = {}
  for (const lang of langs) tables[ns][lang] = loadNs(lang, ns)
}

const rows = [['namespace', 'key', ...langs]]
for (const ns of namespaces) {
  const allKeys = new Set()
  for (const lang of langs) for (const k of Object.keys(tables[ns][lang])) allKeys.add(k)
  for (const k of [...allKeys].sort()) {
    rows.push([ns, k, ...langs.map(l => tables[ns][l][k])])
  }
}

const BOM = '﻿'
const csv = BOM + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'

const outPath = resolveOutputPath(args.out)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, csv, 'utf8')

console.log(`Wrote ${outPath}`)
console.log(`Rows: ${rows.length - 1} across ${namespaces.length} namespace(s), ${langs.length} language(s) [${langs.join(', ')}]`)
for (const ns of namespaces) {
  const counts = langs.map(l => `${l}=${Object.keys(tables[ns][l]).length}`).join(' ')
  console.log(`  ${ns}: ${counts}`)
}
