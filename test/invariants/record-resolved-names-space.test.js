import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { parseSource, forEachNode, staticString } from '../helpers/ast-scan.js'
import { SPACE_ACTIVITY_KINDS } from '../../src/shared/contract/audit-kinds.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', '..', 'src')
const ROOTS = ['shared', 'worker'].map((d) => path.join(SRC, d))

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

// recordResolved marks a space active from its `spaceId` option, because a disabled log never reaches
// the row. A call whose kind can make a space active (a counting literal, or a kind computed at run
// time) must name the option — the space, or null when the caller counts the activity itself.
function namesSpace(options) {
  return options?.type === 'ObjectExpression' &&
    options.properties.some((p) => p.type === 'Property' && p.key.type === 'Identifier' && p.key.name === 'spaceId')
}

test('every recordResolved call that can make a space active names the space', (t) => {
  const missing = []
  let seen = 0
  for (const file of ROOTS.flatMap((r) => walk(r))) {
    const rel = path.relative(SRC, file).split(path.sep).join('/')
    const { ast, visitorKeys } = parseSource(readFileSync(file, 'utf8'), file)
    forEachNode(ast, visitorKeys, (node) => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'recordResolved') return
      seen++
      const kind = staticString(node.arguments[0])
      if (kind !== null && !SPACE_ACTIVITY_KINDS.includes(kind)) return
      if (!namesSpace(node.arguments[2])) missing.push(`${rel}:${node.loc.start.line} ${kind ?? '(computed kind)'}`)
    })
  }
  t.ok(seen > 0, 'the scan found the call sites')
  t.alike(missing, [])
})
