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

// Silenced sites still waiting for their move to recordResolved. The list only shrinks: a file
// that stops appearing must be removed from it, and a file not on it fails outright.
const PENDING = new Map([
  ['shared/spaces/space.js', 1],
  ['shared/transfer/serve-ledger.js', 1],
  ['shared/spaces/member-registry.js', 1],
  ['worker/ipc/membership.js', 1],
])

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

// Silent = keeps nothing at the default level: an empty body, or a body that is only a log.debug.
function isSilentBlock(block) {
  if (block.body.length === 0) return true
  return block.body.length === 1 && block.body[0].type === 'ExpressionStatement' && isDebugCall(block.body[0].expression)
}

function isSilentHandler(fn) {
  if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) return false
  return fn.body.type === 'BlockStatement' ? isSilentBlock(fn.body) : isDebugCall(fn.body)
}

function silencedSites() {
  const sites = []
  for (const { rel, ast, visitorKeys } of files) {
    forEachNode(ast, visitorKeys, (node) => {
      const at = `${rel}:${node.loc.start.line}`
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && calleeName(node.callee) === 'catch' &&
          callsAny(node.callee.object, visitorKeys, AUDIT_WRITES) && isSilentHandler(node.arguments[0])) {
        sites.push({ rel, at, why: 'an audit write whose failure is dropped; use recordResolved' })
      }
      if (node.type === 'TryStatement' && node.handler && callsAny(node.block, visitorKeys, PURGE_PRIMITIVES) &&
          isSilentBlock(node.handler.body)) {
        sites.push({ rel, at, why: 'a purge whose failure is dropped; log it at warn' })
      }
    })
  }
  return sites
}

// REGRESSION (FIX-OBS-2: a failed core purge, the security.serve_denied row and the integrity and
// transfer rows were each dropped at debug or with an empty catch, so the default log level kept no
// trace of a lost security row or a half-finished delete.)
test('REGRESSION (FIX-OBS-2): no audit write or core purge failure is silenced', (t) => {
  const sites = silencedSites()
  const unexpected = sites.filter((s) => !PENDING.has(s.rel)).map((s) => `${s.at} — ${s.why}`)
  t.alike(unexpected, [], 'every silenced site outside the pending list')
  const counts = new Map()
  for (const s of sites) counts.set(s.rel, (counts.get(s.rel) || 0) + 1)
  for (const [rel, allowed] of PENDING) {
    t.is(counts.get(rel) || 0, allowed, `${rel}: still ${allowed} pending site(s) — drop it from the list once fixed`)
  }
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
  t.ok(resolved >= 3, `recordResolved call sites found (${resolved})`)
  t.ok(purges >= 5, `purge call sites found (${purges})`)
})
