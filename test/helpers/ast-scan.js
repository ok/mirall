// Shared parse-and-walk primitives for the guards that assert a property over real source. They
// exist because the guards they replaced matched text: a leading dot, a quote style, an identifier
// name. A parser has no opinion about punctuation, so the same invariant holds however the code is
// spelled.
import tseslint from 'typescript-eslint'

export function parseSource (source, filePath) {
  return tseslint.parser.parseForESLint(source, {
    filePath,
    range: true,
    loc: true,
    sourceType: 'module',
    // `foo<T>()` and `<div/>` are the same two characters, so TS resolves the ambiguity by file
    // extension and so must this.
    ecmaFeatures: { jsx: filePath.endsWith('.tsx') },
  })
}

export function forEachNode (node, visitorKeys, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const key of visitorKeys[node.type] || []) {
    const child = node[key]
    if (Array.isArray(child)) for (const c of child) forEachNode(c, visitorKeys, visit)
    else forEachNode(child, visitorKeys, visit)
  }
}

// A string the reader can see in full at the call site: a plain literal, or a template with no
// interpolation. A name assembled at runtime is not a declaration and is not treated as one.
export function staticString (node) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked
  }
  return null
}

export function calleeName (callee) {
  if (!callee) return null
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression') {
    if (callee.computed) return staticString(callee.property)
    return callee.property.type === 'Identifier' ? callee.property.name : null
  }
  return null
}

// Every Identifier node mapped to the variable it resolves to, so a guard can ask "is this binding
// module-scoped" instead of "does this name look module-scoped".
export function resolutionMap (scopeManager) {
  const resolved = new Map()
  for (const scope of scopeManager.scopes) {
    for (const ref of scope.references) if (ref.resolved) resolved.set(ref.identifier, ref.resolved)
  }
  return resolved
}
