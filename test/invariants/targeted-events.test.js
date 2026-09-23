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
  // Bounded at the array's own closing bracket. Reading to end-of-file swept in whatever was
  // declared next, which silently widened the rule to names it was never about.
  const from = src.indexOf('TARGETED_EVENTS')
  const block = src.slice(from, src.indexOf('])', from))
  const names = [...block.matchAll(/'(event:[a-z-]+)'/g)].map((m) => m[1])
  if (names.length === 0) throw new Error('could not read TARGETED_EVENTS out of events.js')
  return names
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
// untargeted one at runtime with a warn — deliberately, because a progress emit can outlive its own
// request and a throw there lands in the crash backstop's fault window. This is the half that stops such a call site shipping at all.
test('every targeted event is emitted with a target', (t) => {
  const targeted = new Set(targetedNames())
  t.alike([...targeted].sort(), [
    'event:foreign-folder-preview-progress',
    'event:owned-folder-preview-progress',
  ], 'the guard reads exactly the targeted list, not whatever is declared beside it')

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
