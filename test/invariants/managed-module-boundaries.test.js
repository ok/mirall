import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, '..', '..', 'src')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(src, p).split(path.sep).join('/')
const files = walk(src).map((p) => ({ rel: rel(p), src: readFileSync(p, 'utf8') }))
const MODULE = ['shared/managed/', 'worker/managed/', 'renderer/components/managed/']
const inModule = (r) => MODULE.some((dir) => r.startsWith(dir)) || r === 'worker/ipc/managed.js'
const IMPORTS_MODULE = /from '[^']*(shared\/managed\/|worker\/managed\/|components\/managed\/|managed\/[A-Za-z-]+\.(js|tsx?)|ipc\/managed\.js)'/

// The organization configuration is one module; existing code reads the overlay port and reaches the
// module only from the places that compose it. A new importer takes a row here, on purpose.
const COMPOSITION_ROOTS = new Set([
  'worker/boot.js',
  'worker/main.js',
  'worker/ipc/backup.js',
  'renderer/components/modals/BackupSetupModal.tsx',
  'renderer/screens/settings/ActivityLogSettings.tsx',
  'renderer/screens/settings/AuditRecordingCard.tsx',
  'renderer/screens/settings/BackupSettings.tsx',
  'renderer/screens/settings/RelaySettingsSection.tsx',
])

test('only the composition roots import the managed module', (t) => {
  const offenders = files.filter((f) => !inModule(f.rel) && !COMPOSITION_ROOTS.has(f.rel) && IMPORTS_MODULE.test(f.src)).map((f) => f.rel)
  t.alike(offenders, [])
})

test('the overlay port and the effective values import nothing from the managed module', (t) => {
  for (const r of ['shared/core/managed-overlay.js', 'shared/core/managed-effective.js']) {
    t.absent(IMPORTS_MODULE.test(files.find((f) => f.rel === r).src), r)
  }
})

test('nothing outside the managed module knows the license or the Console endpoint', (t) => {
  const offenders = files
    .filter((f) => !inModule(f.rel) && /config-bundles|licenseKey|bundleKeyPair/.test(f.src))
    .map((f) => f.rel)
  t.alike(offenders, [])
})

// Loaded on every install, so loading it must start nothing: no timer, socket, store or subscription
// outside a function body.
test('the managed module has no top-level side effects', (t) => {
  const SIDE_EFFECT = /^(await |setTimeout|setInterval|new (Hyperswarm|Corestore|DriveSource)|fs\.|https?\.|[a-zA-Z_.]+\.on\()/m
  for (const f of files.filter((x) => x.rel.startsWith('shared/managed/') || x.rel.startsWith('worker/managed/'))) {
    t.absent(SIDE_EFFECT.test(f.src), f.rel)
  }
})

test('primitives know nothing of organizations', (t) => {
  for (const f of files.filter((x) => x.rel.startsWith('renderer/components/primitives/'))) {
    t.absent(/managed/i.test(f.src.replace(/\/\/.*$/gm, '')), f.rel)
  }
})
