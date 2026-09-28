import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

// Main and preload read the environment only through src/main/env-overrides.js, which a packaged
// build closes. Each other read is listed here with its reason, so a new MIRALL_* hook cannot reach
// a release by reading process.env directly. `*` is a bare `process.env` (a default parameter),
// `[name]` a computed read.
const ALLOWED = {
  'src/main/env-overrides.js': ['[name]'],                                      // the gate
  'src/main/worker-host.js': ['MIRALL_FOREIGN_FULL_WALK_EVERY', 'MIRALL_LIST_FULL_READ_EVERY'], // release rollback levers
  'src/main/settings-ipc.js': ['APPIMAGE'],                                     // set by the AppImage runtime
  'src/main/updater.js': ['APPIMAGE'],                                          // set by the AppImage runtime
  'src/main/install-kind.js': ['*'],                                            // `env = process.env`, reads APPIMAGE
  'src/main/xdg-integration.js': ['*'],                                         // `env = process.env`, reads APPIMAGE/APPDIR
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

const READ = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\])?/g

/** @param {string} source */
function envReads(source) {
  const code = source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
  return [...code.matchAll(READ)].map((m) => (m[1] ?? (m[2] ? `[${m[2]}]` : '*')))
}

const reads = Object.fromEntries(
  ['src/main', 'src/preload'].flatMap((dir) => walk(path.join(ROOT, dir)))
    .map((file) => [path.relative(ROOT, file), envReads(readFileSync(file, 'utf8'))])
    .filter(([, found]) => found.length > 0),
)

test('REGRESSION (MIR-54: a packaged build honoured MIRALL_* levers): main reads the environment only through the gate', (t) => {
  const stray = Object.entries(reads).flatMap(([file, found]) =>
    found.filter((name) => !(ALLOWED[file] ?? []).includes(name)).map((name) => `${file}: process.env ${name}`))
  t.alike(stray, [], 'every other read goes through envOverride()')
})

test('every allow-listed read still exists', (t) => {
  const stale = Object.entries(ALLOWED).flatMap(([file, names]) =>
    names.filter((name) => !(reads[file] ?? []).includes(name)).map((name) => `${file}: ${name}`))
  t.alike(stale, [], 'a removed read takes its allow-list entry with it')
})
