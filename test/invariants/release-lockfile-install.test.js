import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const RELEASE_WORKFLOW = path.join(ROOT, '.github/workflows/build-electron.yml')

const walk = (dir) => readdirSync(dir).flatMap((entry) => {
  const full = path.join(dir, entry)
  return statSync(full).isDirectory() ? walk(full) : [full]
})

const ciFiles = walk(path.join(ROOT, '.github')).filter((file) => /\.ya?ml$/.test(file))

const NPM_RESOLVE = /\bnpm\s+(?:install|i|add|update|up)\b([^\n]*)/g
// A global tool install is outside the project tree, so it may resolve, but only at an exact version.
const PINNED_GLOBAL = /^\s+(?:-g|--global)\s+(?:@[\w.-]+\/)?[\w.-]+@\d+\.\d+\.\d+\s*$/

test('REGRESSION (MIR-45): the release build installs the committed lockfile and fails if it drifts', (t) => {
  const source = readFileSync(RELEASE_WORKFLOW, 'utf8')
  const install = source.search(/^\s*(?:run:\s*)?npm ci\b/m)
  const drift = source.search(/git diff --exit-code(?: --)? package-lock\.json/)
  const firstBuild = source.search(/npm run (?:build|make:)/)
  t.ok(install >= 0, 'dependencies are installed with npm ci')
  t.ok(drift > install, 'a lockfile drift check runs after the install')
  t.ok(firstBuild > drift, 'nothing is built before the drift check passes')
})

test('no workflow or action deletes the lockfile', (t) => {
  const offenders = ciFiles.filter((file) => /\brm\b[^\n]*package-lock\.json/.test(readFileSync(file, 'utf8')))
  t.alike(offenders.map((file) => path.relative(ROOT, file)), [])
})

test('no workflow or action re-resolves the project tree with npm install', (t) => {
  const offenders = []
  for (const file of ciFiles) {
    for (const match of readFileSync(file, 'utf8').matchAll(NPM_RESOLVE)) {
      if (!PINNED_GLOBAL.test(match[1])) offenders.push(`${path.relative(ROOT, file)}: ${match[0].trim()}`)
    }
  }
  t.alike(offenders, [])
})

const lockedPackages = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).packages

const isLocked = (from, name) => {
  for (let dir = from; ; dir = dir.slice(0, Math.max(dir.lastIndexOf('/node_modules/'), 0))) {
    if (lockedPackages[`${dir ? `${dir}/` : ''}node_modules/${name}`]) return true
    if (!dir) return false
  }
}

// npm ci installs only what the lock names; a platform binding missing from it fails that runner's build.
test('the lockfile names every optional dependency its packages declare, for every platform', (t) => {
  const missing = []
  for (const [location, entry] of Object.entries(lockedPackages)) {
    for (const name of Object.keys(entry.optionalDependencies ?? {})) {
      if (!isLocked(location, name)) missing.push(`${location || '(root)'} -> ${name}`)
    }
  }
  t.alike(missing, [])
})
