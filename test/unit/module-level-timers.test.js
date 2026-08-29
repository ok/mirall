import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { Linter } from 'eslint'
import { moduleLevelTimerRestrictions } from '../../eslint.config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const roots = ['shared', 'worker'].map((d) => path.join(here, '..', '..', 'src', d))

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'vendor') walk(p, out) } else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

function verify (linter, source, filename) {
  return linter.verify(source, {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: { 'no-restricted-syntax': ['error', ...moduleLevelTimerRestrictions] },
  }, filename)
}

// REGRESSION (LIFECYCLE-1c: a timer armed at module level runs at import, where no close() can
// ever reach it. Five sites did this — echo-guard's purge and the worker entry's four sweeps —
// and every one of them outlived the shutdown sequence.)
test('REGRESSION (LIFECYCLE-1c): no data-layer module arms a timer at module level', (t) => {
  const linter = new Linter()
  // The grammar itself, on fixtures: what must be caught, and what must stay legal.
  t.ok(verify(linter, 'setInterval(() => {}, 1).unref?.()\n', 'control.js').length > 0, 'the chained-unref shape is caught')
  t.ok(verify(linter, 'const t = setInterval(() => {}, 1)\n', 'control2.js').length > 0, 'the held-handle shape is caught')
  t.ok(verify(linter, 'export const t = setTimeout(() => {}, 1)\n', 'control3.js').length > 0, 'an exported handle is caught')
  // Every nesting a module-level timer can hide in. A selector scoped to top-level statement
  // types misses all of these, and `if (isFeatureOn()) setInterval(sweep, 60_000)` is exactly the
  // shape a future flag-guarded sweep takes.
  for (const [label, src] of [
    ['a top-level if', 'if (x) setInterval(() => {}, 1)\n'],
    ['a braced top-level if', 'if (x) { setInterval(() => {}, 1) }\n'],
    ['a top-level try', 'try { setInterval(() => {}, 1) } catch {}\n'],
    ['a bare block', '{ setInterval(() => {}, 1) }\n'],
    ['a labelled block', 'a: { setInterval(() => {}, 1) }\n'],
    ['a for-of', 'for (const x of []) setInterval(() => {}, 1)\n'],
    ['a while', 'while (x) setInterval(() => {}, 1)\n'],
    ['a switch case', 'switch (x) { case 1: setInterval(() => {}, 1) }\n'],
    ['a class static field', 'class C { static t = setInterval(() => {}, 1) }\n'],
    ['a class static block', 'class C { static { setInterval(() => {}, 1) } }\n'],
    ['an export default', 'export default setInterval(() => {}, 1)\n'],
  ]) {
    t.ok(verify(linter, src, 'nested.js').length > 0, label + ' is caught')
  }
  t.alike(verify(linter, 'export function start () { return setInterval(() => {}, 1) }\n', 'ok.js'), [], 'inside a function stays legal')
  t.alike(verify(linter, 'const f = () => setTimeout(() => {}, 1)\n', 'ok2.js'), [], 'inside an arrow function stays legal')
  t.alike(verify(linter, 'await new Promise((r) => setTimeout(r, 150))\n', 'ok3.js'), [], 'a delay inside a promise stays legal')
  t.alike(verify(linter, 'class C { m () { setInterval(() => {}, 1) } }\n', 'ok4.js'), [], 'inside a class method stays legal')

  for (const file of roots.flatMap((r) => walk(r))) {
    const messages = verify(linter, readFileSync(file, 'utf8'), file)
    t.alike(messages.map((m) => `${m.line}: ${m.message}`), [], path.relative(process.cwd(), file))
  }
})
