// A line-free identity for a lint report, so a ratchet can hold a SET of sites rather than a count
// per file: fixing one site and adding another is a different set, however the lines move. The key
// is the chain of named scopes around the reported node (function, variable, property, JSX
// attribute, the hook or method a callback is handed to) plus the reported code itself.
import { parseSource, calleeName } from './ast-scan.js'

const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'])
const CODE_WIDTH = 80
// A continuation says nothing the reported code does not already show.
const CONTINUATIONS = new Set(['then', 'catch', 'finally'])

function childrenOf(node, visitorKeys) {
  const out = []
  for (const key of visitorKeys[node.type] || []) {
    const child = node[key]
    if (Array.isArray(child)) { for (const c of child) if (c && typeof c.type === 'string') out.push(c) } else if (child && typeof child.type === 'string') out.push(child)
  }
  return out
}

// The path from the program down to the deepest node spanning [start, end].
function pathTo(ast, visitorKeys, start, end) {
  const path = [ast]
  for (;;) {
    const next = childrenOf(path[path.length - 1], visitorKeys).find((c) => c.range[0] <= start && c.range[1] >= end)
    if (!next) return path
    path.push(next)
  }
}

function scopeName(node, child) {
  if (node.type === 'FunctionDeclaration' && node.id) return node.id.name
  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') return node.id.name
  if ((node.type === 'Property' || node.type === 'MethodDefinition') && !node.computed && node.key.type === 'Identifier') return node.key.name
  if (node.type === 'JSXAttribute' && node.name.type === 'JSXIdentifier') return node.name.name
  if (node.type === 'CallExpression' && FUNCTIONS.has(child.type) && node.arguments.includes(child)) {
    const name = calleeName(node.callee)
    return CONTINUATIONS.has(name) ? null : name
  }
  return null
}

function offsetOf(lineStarts, line, column) {
  return lineStarts[line - 1] + column - 1
}

// A no-op handler or an empty catch block reads the same everywhere; the call or the try it belongs
// to is what tells two of them apart.
function codeNode(path) {
  const node = path[path.length - 1]
  const parent = path[path.length - 2]
  if (node.type === 'BlockStatement' && parent?.type === 'CatchClause') return path[path.length - 3]
  if (parent?.type === 'CallExpression' && parent.arguments.includes(node)) return parent
  return node
}

export function siteKeys(source, filePath, messages) {
  const { ast, visitorKeys } = parseSource(source, filePath)
  const lineStarts = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1)
  return messages.map((m) => {
    const start = offsetOf(lineStarts, m.line, m.column)
    const end = offsetOf(lineStarts, m.endLine, m.endColumn)
    const path = pathTo(ast, visitorKeys, start, end)
    const where = []
    for (let i = 0; i < path.length - 1; i++) {
      const name = scopeName(path[i], path[i + 1])
      if (name && where[where.length - 1] !== name) where.push(name)
    }
    const code = codeNode(path)
    const text = source.slice(code.range[0], code.range[1]).replace(/\s+/g, ' ').slice(0, CODE_WIDTH)
    const rule = m.ruleId === 'no-restricted-syntax' ? '' : `${m.ruleId.replace('@typescript-eslint/', '')} `
    return `${rule}${where.join(' > ') || '(module)'}: ${text}`
  })
}
