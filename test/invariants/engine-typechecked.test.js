import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENGINE = 'src/shared/transfer/overlay/engine'

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

// The overlay engine is outside tsconfig.json's renderer-and-contract set, so it is held to its own
// JSDoc only through tsconfig.engine.json, and only while `npm run typecheck` runs that config.
test('the engine config covers the engine and typecheck runs it', (t) => {
  const config = JSON.parse(readFileSync(path.join(root, 'tsconfig.engine.json'), 'utf8'))
  t.ok(config.include.includes(`${ENGINE}/**/*.js`), 'tsconfig.engine.json includes every engine module')
  t.ok(config.compilerOptions.checkJs, 'and checks them')
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts
  t.ok(/tsc -p tsconfig\.engine\.json/.test(scripts.typecheck), 'npm run typecheck runs the engine config')
})

// A directive undoes the check for everything after it, so the engine carries none: an error is
// fixed, not silenced.
test('nothing in the engine switches the check off', (t) => {
  const silenced = walk(path.join(root, ENGINE)).filter((f) => /@ts-(nocheck|ignore|expect-error)\b/.test(readFileSync(f, 'utf8')))
  t.alike(silenced.map((f) => path.relative(root, f)), [], 'engine modules carrying @ts-nocheck, @ts-ignore or @ts-expect-error')
})
