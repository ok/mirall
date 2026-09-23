import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseSource, forEachNode, calleeName, staticString } from '../helpers/ast-scan.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../..')
const WORKER = path.join(ROOT, 'src/worker')

// The typed ipc.handle rejects a handler whose result is not assignable to its row, but assignable
// is not equal: TypeScript runs no excess-property check on an inferred return, so { ok: true,
// removed: 1 } satisfies Ack. This pins the part the types cannot — the rows typed `Ack` answer the
// literal { ok: true } and nothing else.
//
// Read as text, per this folder's rule: a guard scans src/** and imports nothing from it.
function ackRows() {
  const src = readFileSync(path.join(ROOT, 'src/shared/contract/responses.ts'), 'utf8')
  const map = src.slice(src.indexOf('interface Responses {'))
  return new Set([...map.matchAll(/^\s*'([^']+)': Ack$/gm)].map((m) => m[1]))
}

function workerFiles() {
  const out = [path.join(WORKER, 'main.js')]
  for (const name of readdirSync(path.join(WORKER, 'ipc'))) {
    if (name.endsWith('.js')) out.push(path.join(WORKER, 'ipc', name))
  }
  return out
}

// Every `return` in the handler's OWN body — not in a callback it passes elsewhere.
function returnsOf(fn, visitorKeys) {
  // A concise arrow body IS the return: `async (msg) => doThing(msg)` has no ReturnStatement.
  if (fn.body && fn.body.type !== 'BlockStatement') return [fn.body]
  const out = []
  const walk = (node, inNested) => {
    if (!node || typeof node.type !== 'string') return
    const nested = inNested || (node !== fn && (node.type === 'ArrowFunctionExpression' ||
      node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration'))
    if (node.type === 'ReturnStatement' && !nested) out.push(node.argument)
    for (const key of visitorKeys[node.type] || []) {
      const child = node[key]
      if (Array.isArray(child)) for (const c of child) walk(c, nested)
      else walk(child, nested)
    }
  }
  walk(fn, false)
  return out
}

const isAckLiteral = (node) =>
  node?.type === 'ObjectExpression' &&
  node.properties.length === 1 &&
  node.properties[0]?.key?.name === 'ok' &&
  node.properties[0]?.value?.value === true

test('every request typed Ack returns exactly { ok: true }', (t) => {
  const acks = ackRows()
  t.ok(acks.size >= 20, `${acks.size} rows are typed Ack`)

  const wrong = []
  const seen = new Set()
  for (const file of workerFiles()) {
    const source = readFileSync(file, 'utf8')
    const { ast, visitorKeys } = parseSource(source, file)
    const consts = new Map()
    forEachNode(ast, visitorKeys, (n) => {
      if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init &&
        (n.init.type === 'ArrowFunctionExpression' || n.init.type === 'FunctionExpression')) consts.set(n.id.name, n.init)
    })
    forEachNode(ast, visitorKeys, (n) => {
      if (n.type !== 'CallExpression' || calleeName(n.callee) !== 'handle') return
      const name = staticString(n.arguments[0])
      if (!name || !acks.has(name)) return
      seen.add(name)
      let fn = n.arguments[1]
      if (fn?.type === 'Identifier') fn = consts.get(fn.name)
      if (!fn) { wrong.push(`${name}: handler could not be resolved`); return }
      const returns = returnsOf(fn, visitorKeys)
      if (returns.length === 0) { wrong.push(`${name}: returns nothing, but its row promises { ok: true }`); return }
      for (const r of returns) {
        if (!isAckLiteral(r)) wrong.push(`${name}: returns something other than { ok: true }`)
      }
    })
  }

  t.alike(wrong, [], 'a row typed Ack whose handler disagrees')
  // Every Ack row must have been reached: a row nobody registers is one this guard never checked.
  t.alike([...acks].filter((name) => !seen.has(name)), [],
    'an Ack row with no handler found — the scan missed it, or the row is dead')
})
