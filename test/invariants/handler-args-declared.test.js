import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseSource, forEachNode, calleeName, staticString } from '../helpers/ast-scan.js'

// A read the guard must see through: `msg?.x` parses as a plain MemberExpression under this parser
// when the whole chain is optional, so both node kinds are treated the same way.

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../..')
const WORKER = path.join(ROOT, 'src/worker')

// The contract is only a description of the surface if the handlers read nothing it does not
// declare. Two failure shapes, both of which existed: a field read straight off the frame with no
// row for it, and the whole frame handed to a data-layer function — which carried the envelope
// (id, type) along with the filters and made the args table decorative.
//
// Rows are parsed out of requests.js as text, per this folder's rule: a guard imports nothing from
// src/, so the contract cannot satisfy its own rule by changing what it exports.
function declaredArgs() {
  const file = path.join(ROOT, 'src/shared/contract/requests.js')
  const source = readFileSync(file, 'utf8')
  const { ast, visitorKeys } = parseSource(source, file)
  const rows = new Map()
  forEachNode(ast, visitorKeys, (node) => {
    // `export const REQUESTS = Object.freeze({ … })`
    if (node.type !== 'VariableDeclarator' || node.id?.name !== 'REQUESTS') return
    const table = node.init?.type === 'CallExpression' ? node.init.arguments[0] : node.init
    if (table?.type !== 'ObjectExpression') return
    for (const row of table.properties) {
      const name = staticString(row.key) ?? row.key?.name
      const args = row.value?.properties?.find((prop) => prop.key?.name === 'args')?.value
      if (!name || args?.type !== 'ObjectExpression') continue
      rows.set(name, new Set(args.properties.map((f) => staticString(f.key) ?? f.key?.name).filter(Boolean)))
    }
  })
  return rows
}

function workerFiles() {
  const out = [path.join(WORKER, 'main.js')]
  for (const name of readdirSync(path.join(WORKER, 'ipc'))) {
    if (name.endsWith('.js')) out.push(path.join(WORKER, 'ipc', name))
  }
  return out
}

// `ipc.handle('name', fn)` where fn is inline, or a reference resolved one hop to a const in the
// same file. Anything the scan cannot resolve FAILS rather than being skipped: an unscannable
// handler is an unpoliced one, which is how the gap this guards opened in the first place.
function handlersIn(source, file) {
  const { ast, visitorKeys } = parseSource(source, file)
  const consts = new Map()
  const found = []
  forEachNode(ast, visitorKeys, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init &&
      (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')) {
      consts.set(node.id.name, node.init)
    }
  })
  forEachNode(ast, visitorKeys, (node) => {
    if (node.type !== 'CallExpression' || calleeName(node.callee) !== 'handle') return
    const name = staticString(node.arguments[0])
    if (!name) return
    const arg = node.arguments[1]
    if (!arg) return
    if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') {
      found.push({ name, fn: arg, resolved: true })
    } else if (arg.type === 'Identifier' && consts.has(arg.name)) {
      found.push({ name, fn: consts.get(arg.name), resolved: true })
    } else {
      found.push({ name, fn: null, resolved: false })
    }
  })
  return { found, visitorKeys }
}

// forEachNode visits without a parent, and the question here is entirely about the parent: whether
// an identifier is the OBJECT of a member expression (a field read) or standing alone (the frame
// itself leaving). So this guard walks with one.
function walkWithParent(node, visitorKeys, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return
  visit(node, parent)
  for (const key of visitorKeys[node.type] || []) {
    const child = node[key]
    if (Array.isArray(child)) for (const c of child) walkWithParent(c, visitorKeys, visit, node)
    else walkWithParent(child, visitorKeys, visit, node)
  }
}

// Every `p.x` / `p?.x` read off the first parameter, and whether the bare parameter escapes.
function readsOf(fn, visitorKeys) {
  const param = fn.params?.[0]
  const reads = new Set()
  let forwards = false
  if (!param) return { reads, forwards, destructured: null }
  if (param.type === 'ObjectPattern') {
    const keys = param.properties.map((prop) => prop.key?.name).filter(Boolean)
    return { reads: new Set(keys), forwards: false, destructured: keys }
  }
  if (param.type !== 'Identifier') return { reads, forwards, destructured: null }
  const name = param.name
  walkWithParent(fn.body, visitorKeys, (node, parent) => {
    if (node.type !== 'Identifier' || node.name !== name) return
    const isMemberObject = parent && (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.object === node
    if (isMemberObject) {
      const prop = parent.property
      if (!parent.computed && prop?.type === 'Identifier') reads.add(prop.name)
      return
    }
    // The parameter used as a value: passed along, spread, returned. That is the whole frame
    // leaving the boundary with its envelope attached.
    if (parent && parent.type === 'VariableDeclarator' && parent.id === node) return
    forwards = true
  })
  return { reads, forwards, destructured: null }
}

test('every field a handler reads is declared, and no handler forwards the whole frame', (t) => {
  const rows = declaredArgs()
  // Strict, because every check below is vacuous if the table did not parse: a guard that reads
  // nothing agrees with everything.
  t.ok(rows.size >= 86, `parsed ${rows.size} contract rows`)

  const undeclared = []
  const forwarded = []
  const unscannable = []

  for (const file of workerFiles()) {
    const source = readFileSync(file, 'utf8')
    const { found, visitorKeys } = handlersIn(source, file)
    for (const { name, fn, resolved } of found) {
      const where = `${path.relative(ROOT, file)}: ${name}`
      if (!resolved) { unscannable.push(where); continue }
      const declared = rows.get(name)
      // A handler for a name the contract does not declare cannot boot (handler-table throws), so
      // reaching here at all would mean the table failed to parse.
      if (!declared) { unscannable.push(`${where} (no contract row parsed)`); continue }
      const { reads, forwards } = readsOf(fn, visitorKeys)
      for (const field of reads) {
        if (!declared.has(field)) undeclared.push(`${where}.${field}`)
      }
      if (forwards) forwarded.push(where)
    }
  }

  t.alike(unscannable, [], 'a handler this guard cannot read is a handler it cannot police')
  t.alike(undeclared, [], 'read off the frame with no row in the contract')
  t.alike(forwarded, [], 'the whole frame left the boundary — project the fields it needs instead')
})
