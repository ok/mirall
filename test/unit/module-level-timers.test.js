import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { Linter } from 'eslint'
import { moduleLevelTimerRestrictions, moduleScopeTimerHandleRestrictions } from '../../eslint.config.mjs'

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

function verifyHandles (linter, source, filename) {
  return linter.verify(source, {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: { 'no-restricted-syntax': ['error', ...moduleScopeTimerHandleRestrictions] },
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

// The twelve sites the rule above could not see: a timer armed inside a function but held in a
// binding that outlives the call, so nothing scoped to the call clears it. The worst of them sat
// in a file whose own Subsystem was 368 lines below, with an unused `this.timers` on it.
test('REGRESSION (ADOPT-B1): a long-lived timer handle is not armed from the global', (t) => {
  const linter = new Linter()

  for (const [label, src] of [
    ['an interval assigned to a compound handle', 'let announceTimer = null\nfunction arm () { announceTimer = setInterval(() => {}, 1) }\n'],
    ['a timeout assigned to a compound handle', 'let dwellTimer = null\nfunction arm () { dwellTimer = setTimeout(() => {}, 1) }\n'],
    ['a re-arming tail', 'let peerTimer = null\nfunction arm () { peerTimer = setTimeout(() => { peerTimer = null; arm() }, 1) }\n'],
    ['a heartbeat by that name', 'let presenceBeat = null\nfunction arm () { presenceBeat = setInterval(() => {}, 1) }\n'],
    ['a module-scope declarator with an init', 'const idleTimer = setTimeout(() => {}, 1)\n'],
    // REGRESSION (REVIEW-6: the selector matched an Identifier target only, so the most natural
    // shape in a Subsystem-based codebase — a handle kept on `this` — slipped straight through the
    // rule whose stated job is to stop the thirteenth.)
    ['a handle kept on this', 'class C { arm () { this.sweepTimer = setInterval(() => {}, 1) } }\n'],
    ['a handle kept on a module singleton', 'const state = {}\nfunction arm () { state.dwellTimer = setTimeout(() => {}, 1) }\n'],
  ]) {
    t.ok(verifyHandles(linter, src, 'bad.js').length > 0, label + ' is caught')
  }

  // The fix, and the shapes that must stay legal — otherwise the rule forces twelve inline
  // disables and stops being a guard.
  for (const [label, src] of [
    ['arming through a module-owned set', 'let announceTimer = null\nfunction arm () { announceTimer = timers.setInterval(() => {}, 1) }\n'],
    ['arming through a subsystem set', "class S { arm () { this.dwellTimer = this.timers.setTimeout(() => {}, 1) } }\n"],
    ['arming through a current pointer', 'let idleTimer = null\nfunction arm () { idleTimer = current.timers.setTimeout(() => {}, 1) }\n'],
    // A bare local handle is owned by its function, which clears it on both exits. Three of these
    // exist in the data layer; flagging them would be a false positive on correct code.
    ['a function-local bare handle', 'function race () { let timer = setTimeout(() => {}, 1); clearTimeout(timer) }\n'],
    ['a promise delay', 'async function wait () { await new Promise((r) => { const t = setTimeout(r, 1); t.unref?.() }) }\n'],
  ]) {
    t.alike(verifyHandles(linter, src, 'ok.js'), [], label + ' stays legal')
  }

  // The ratchet: zero across the real tree, which is what makes the rule a floor rather than a
  // wish. Both rules are run, so removing either is visible here.
  for (const file of roots.flatMap((r) => walk(r))) {
    const messages = verifyHandles(linter, readFileSync(file, 'utf8'), file)
    t.alike(messages.map((m) => `${m.line}: ${m.message}`), [], path.relative(process.cwd(), file))
  }
})
