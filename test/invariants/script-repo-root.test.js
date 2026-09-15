import test from 'brittle'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scriptsDir = path.join(root, 'scripts')

const walk = (dir) => readdirSync(dir).flatMap((entry) => {
  const full = path.join(dir, entry)
  return statSync(full).isDirectory() ? walk(full) : [full]
})

const scripts = walk(scriptsDir).filter((file) => /\.(sh|mjs|cjs|js)$/.test(file))

// A script climbs to the repo root by a hard-coded number of `..` from its own directory. Move the
// script one folder deeper and that count is silently wrong: it resolves to some other directory
// that exists, so nothing throws until the script runs. build-app-image.sh broke the Linux CI build
// that way, and both icon generators carried the same stale climb.
test('every script that climbs to the repo root lands on it', (t) => {
  const wrong = []
  for (const file of scripts) {
    const source = readFileSync(file, 'utf8')
    const climbs = [
      ...source.matchAll(/dirname\s+"\$0"\)(\/\.\.(?:\/\.\.)*)/g),
      ...source.matchAll(/fileURLToPath\(import\.meta\.url\)\),\s*'(\.\.(?:\/\.\.)*)'/g),
      ...source.matchAll(/__dirname,\s*'(\.\.(?:\/\.\.)*)'/g),
    ].map((match) => match[1].replace(/^\//, ''))
    for (const climb of climbs) {
      const resolved = path.resolve(path.dirname(file), climb)
      if (resolved !== root) wrong.push(`${path.relative(root, file)} -> ${path.relative(root, resolved) || '.'}`)
    }
  }
  t.alike(wrong.sort(), [], 'scripts resolve a repo root that is not the repo root')
})

// The climb landing on the root is only half of it: the paths built from that root must exist.
test('every repo-root-relative path a script names exists', (t) => {
  const missing = []
  for (const file of scripts) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:path\.)?join\(ROOT,\s*((?:'[^']+',?\s*)+)\)/g)) {
      const segments = [...match[1].matchAll(/'([^']+)'/g)].map((segment) => segment[1])
      const target = path.join(root, ...segments)
      if (!existsSync(target)) missing.push(`${path.relative(root, file)} -> ${segments.join('/')}`)
    }
  }
  t.alike(missing.sort(), [], 'scripts name repo paths that do not exist')
})
