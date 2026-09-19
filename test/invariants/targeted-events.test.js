import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseSource, forEachNode, staticString, calleeName } from '../helpers/ast-scan.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../../src')

// The list is read as text, not imported: a guard here scans src/** and imports nothing from it,
// so the contract cannot make its own rule pass by changing what it exports.
function targetedNames() {
  const src = readFileSync(path.join(SRC, 'shared/contract/events.js'), 'utf8')
  const block = src.slice(src.indexOf('TARGETED_EVENTS'))
  return [...block.matchAll(/'(event:[a-z-]+)'/g)].map((m) => m[1])
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'vendor') walk(p, out) }
    else if (p.endsWith('.js')) out.push(p)
  }
  return out
}

// An event that belongs to one caller's operation must name that caller. The router drops an
// untargeted one at runtime with a warn — deliberately, because leave-progress fires from a
// teardown that outlives its own request and a throw there lands in the crash backstop's fault
// window. This is the half that stops such a call site shipping at all.
test('every targeted event is emitted with a target', (t) => {
  const targeted = new Set(targetedNames())
  t.ok(targeted.size > 0, `the contract names ${targeted.size} targeted event(s)`)

  const untargeted = []
  for (const file of [...walk(path.join(SRC, 'worker')), ...walk(path.join(SRC, 'shared'))]) {
    const source = readFileSync(file, 'utf8')
    if (![...targeted].some((name) => source.includes(name))) continue
    const { ast, visitorKeys } = parseSource(source, file)
    forEachNode(ast, visitorKeys, (node) => {
      if (node.type !== 'CallExpression' || calleeName(node.callee) !== 'emit') return
      const name = staticString(node.arguments[0])
      if (!name || !targeted.has(name)) return
      if (node.arguments.length < 3) untargeted.push(`${path.relative(SRC, file)}: ${name}`)
    })
  }
  t.alike(untargeted, [], 'emit(name, payload, { to: client }) — a targeted event names its client')
})
