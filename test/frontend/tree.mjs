// agent-desktop AX node fields: ref is `ref_id`; visible text content -> `name`;
// aria-label/title -> `description`; static text + input values -> `value`.
export function flatten(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.role) {
    const name = node.name ?? ''
    const description = node.description ?? ''
    const value = typeof node.value === 'string' ? node.value : ''
    out.push({
      ref: node.ref_id ?? null,
      role: node.role,
      name,
      description,
      value,
      states: node.states ?? [],
      label: name || description || value,
    })
  }
  for (const k of node.children ?? []) flatten(k, out)
  return out
}

// `actionable` drops `statictext` from consideration. agent-desktop 0.4.x removed
// static text from the interactive lens (-i) entirely; 0.8.x keeps it AND gives it a
// ref, so a <label for> now appears as a ref'd statictext carrying the very same
// accessible name as the control it labels. Being earlier in document order it wins
// any name-only match, so ref resolution for a click/type silently retargeted the
// label — set-value wrote to it and the read-back returned the label text instead of
// the field's. Static text is never a valid action target, so ref resolution skips
// it; assertions deliberately do not, since that is where visible text lives.
export function findNode(tree, { role, name, contains, last = false, actionable = false }) {
  const matches = flatten(tree).filter(
    (n) =>
      (role == null || n.role === role) &&
      (!actionable || n.role !== 'statictext') &&
      (name == null || n.name === name || n.description === name) &&
      (contains == null || n.label.includes(contains)),
  )
  return (last ? matches.at(-1) : matches[0]) ?? null
}

export function allText(tree) {
  return flatten(tree)
    .map((n) => `${n.name} ${n.description} ${n.value}`)
    .join('\n')
}
