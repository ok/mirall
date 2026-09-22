import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { parseSource, forEachNode, calleeName } from '../helpers/ast-scan.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', '..', 'src')
const ROOTS = ['shared', 'worker'].map((d) => path.join(SRC, d))

// The two kinds of evidence a support bundle cannot reconstruct: an audit row, and the outcome of
// a delete. A failure of either is kept at the default log level.
const AUDIT_WRITES = new Set(['record'])
const PURGE_PRIMITIVES = new Set(['purgeCoreDk', 'clearAndPurgeCore', 'purgeAlias'])
const GUARDED = new Set([...AUDIT_WRITES, ...PURGE_PRIMITIVES])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== 'vendor') walk(p, out)
    } else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

const files = ROOTS.flatMap((r) => walk(r)).map((file) => ({
  rel: path.relative(SRC, file).split(path.sep).join('/'),
  ...parseSource(readFileSync(file, 'utf8'), file),
}))

function callsAny(node, visitorKeys, names) {
  let hit = false
  forEachNode(node, visitorKeys, (n) => {
    if (!hit && n.type === 'CallExpression' && n.callee.type === 'Identifier' && names.has(n.callee.name)) hit = true
  })
  return hit
}

const isDebugCall = (expr) => expr?.type === 'CallExpression' && expr.callee.type === 'MemberExpression' &&
  expr.callee.object.type === 'Identifier' && expr.callee.object.name === 'log' && calleeName(expr.callee) === 'debug'

// Nothing kept at the default level: only log.debug lines, and at most a bare continue or return.
function isSilentStatement(st) {
  if (st.type === 'ExpressionStatement') return isDebugCall(st.expression)
  if (st.type === 'ContinueStatement') return true
  return st.type === 'ReturnStatement' && (!st.argument || st.argument.type === 'Literal' || st.argument.type === 'Identifier')
}

const isSilentBlock = (block) => block.body.every(isSilentStatement)

// A handler that swallows: `() => {}`, `() => null`, `() => void 0`, `() => log.debug(…)`, or `noop`.
function isSilentHandler(fn) {
  if (!fn) return false
  if (fn.type === 'Identifier') return fn.name === 'noop'
  if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') return false
  const body = fn.body
  if (body.type === 'BlockStatement') return isSilentBlock(body)
  return isDebugCall(body) || body.type === 'Literal' || body.type === 'Identifier' ||
    (body.type === 'UnaryExpression' && body.operator === 'void')
}

// `x.catch(silent)` or `x.then(ok, silent)` where x, or ok, writes a row or purges.
function isSilencedCall(node, visitorKeys) {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return false
  const name = calleeName(node.callee)
  const handler = name === 'catch' ? node.arguments[0] : name === 'then' ? node.arguments[1] : null
  if (!isSilentHandler(handler)) return false
  return callsAny(node.callee.object, visitorKeys, GUARDED) || (name === 'then' && callsAny(node.arguments[0], visitorKeys, GUARDED))
}

const isSilencedTry = (node, visitorKeys) => node.type === 'TryStatement' && !!node.handler &&
  isSilentBlock(node.handler.body) && callsAny(node.block, visitorKeys, GUARDED)

function silencedSites() {
  const sites = []
  for (const { rel, ast, visitorKeys } of files) {
    forEachNode(ast, visitorKeys, (node) => {
      if (isSilencedCall(node, visitorKeys) || isSilencedTry(node, visitorKeys)) sites.push(`${rel}:${node.loc.start.line}`)
    })
  }
  return sites
}

// REGRESSION (FIX-OBS-2: a failed core purge, the security.serve_denied row and the integrity and
// transfer rows were each dropped at debug or with an empty catch, so the default log level kept no
// trace of a lost security row or a half-finished delete.)
test('REGRESSION (FIX-OBS-2): no audit write or core purge failure is silenced', (t) => {
  t.alike(silencedSites(), [], 'no audit write or purge whose failure is dropped; route it through recordResolved or log it at warn')
})

// The scan must be looking at the real shapes, or an empty result proves nothing.
test('the scan sees the audit writers and purge sites it guards', (t) => {
  let resolved = 0
  let purges = 0
  for (const { ast, visitorKeys } of files) {
    forEachNode(ast, visitorKeys, (node) => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return
      if (node.callee.name === 'recordResolved') resolved++
      if (PURGE_PRIMITIVES.has(node.callee.name)) purges++
    })
  }
  t.ok(resolved >= 7, `recordResolved call sites found (${resolved})`)
  t.ok(purges >= 5, `purge call sites found (${purges})`)
})

test('the silent-handler shapes are all recognised', (t) => {
  const shapes = [
    'f().then(() => record(k)).catch(() => {})',
    'f().then(() => record(k)).catch(() => null)',
    'f().then(() => record(k)).catch(() => void 0)',
    'f().then(() => record(k)).catch(noop)',
    'f().then(() => record(k), () => {})',
    'purgeCoreDk(cs, dk).catch(() => {})',
    'async function g() { try { await purgeCoreDk(cs, dk) } catch (err) { log.debug(err.message); return } }',
    'async function g() { try { record(k) } catch {} }',
  ]
  for (const src of shapes) {
    const { ast, visitorKeys } = parseSource(src, 'shape.js')
    let hit = false
    forEachNode(ast, visitorKeys, (node) => {
      if (isSilencedCall(node, visitorKeys) || isSilencedTry(node, visitorKeys)) hit = true
    })
    t.ok(hit, src)
  }
})
