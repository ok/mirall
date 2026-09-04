import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { parseSource, forEachNode, calleeName, resolutionMap } from '../helpers/ast-scan.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

const ARM = new Set(['setInterval', 'setTimeout'])
const DISARM = new Set(['clearInterval', 'clearTimeout'])

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'vendor') walk(p, out) } else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

// A handle held in a module-scoped variable and armed inside a function is legal under
// eslint.config.mjs's moduleLevelTimerRestrictions, which only forbids a timer armed at IMPORT.
// This is the next question that rule cannot ask: whether the module that armed it holds anything
// that can disarm it. A handle nothing can ever clear is a leak by construction — no reachability
// analysis needed to say so.
function uncleared (source, filePath) {
  const { ast, visitorKeys, scopeManager } = parseSource(source, filePath)
  const resolved = resolutionMap(scopeManager)
  const armed = new Map()
  const cleared = new Set()

  forEachNode(ast, visitorKeys, (node) => {
    // A BARE set*() only. `this.timers.setTimeout(…)` is the Subsystem facility that owns the
    // ending itself (src/shared/core/timers.js), which is the shape the lint message asks for.
    if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'Identifier' &&
        node.right && node.right.type === 'CallExpression' &&
        node.right.callee.type === 'Identifier' && ARM.has(node.right.callee.name)) {
      const variable = resolved.get(node.left)
      if (variable && variable.scope.type === 'module') {
        armed.set(variable, (armed.get(variable) || []).concat(node.loc.start.line))
      }
    }
    if (node.type === 'CallExpression' && DISARM.has(calleeName(node.callee))) {
      const arg = node.arguments[0]
      if (arg && arg.type === 'Identifier') {
        const variable = resolved.get(arg)
        if (variable) cleared.add(variable)
      }
    }
  })

  return [...armed].filter(([variable]) => !cleared.has(variable))
    .map(([variable, lines]) => `${variable.name} (armed at ${lines.join(', ')})`)
}

// The companion to test/unit/module-level-timers.test.js, which proves the IMPORT-TIME property and
// is correct about it. What neither can prove — and what the lint message used to imply — is that a
// handle's reset is actually CALLED before the process that armed it goes away: three of the owners
// are module singletons, not Subsystems, so that needs a call graph across modules. The runtime
// proof of the broad property is test/integration/timer-lifecycle.test.js. This is the decidable
// corner, stated as exactly that.
test('every module-scoped timer handle has a matching clear in its own module', (t) => {
  t.alike(uncleared('let h\nfunction f () { h = setInterval(tick, 1000) }\n', 'control.js'),
    ['h (armed at 2)'], 'a module-scoped interval with no clear is caught')
  t.alike(uncleared('let h\nfunction f () { h = setTimeout(tick, 1000) }\n', 'control2.js'),
    ['h (armed at 2)'], 'and a module-scoped timeout')
  t.alike(uncleared('let handle\nfunction arm () { handle = setInterval(tick, 1) }\nfunction reset () { clearInterval(handle) }\n', 'ok.js'),
    [], 'a matching clear in the same module is the supported shape')
  t.alike(uncleared('function f () { let h = setTimeout(tick, 1) }\n', 'ok2.js'),
    [], 'a function-scoped handle dies with the call')
  t.alike(uncleared('async function f () { await new Promise((r) => setTimeout(r, 5)) }\n', 'ok3.js'),
    [], 'a one-shot delay holds no handle at all')
  t.alike(uncleared('let h\nfunction f (current) { h = current.timers.setTimeout(tick, 1) }\n', 'ok4.js'),
    [], 'the Subsystem timer facility owns its own ending')

  const files = [...walk(path.join(root, 'src', 'shared')), ...walk(path.join(root, 'src', 'worker'))]
  t.ok(files.length > 0, 'the data layer was actually walked')
  for (const file of files) {
    t.alike(uncleared(readFileSync(file, 'utf8'), file), [], path.relative(root, file))
  }
})
