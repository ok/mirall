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

export function findNode(tree, { role, name, contains, last = false }) {
  const matches = flatten(tree).filter(
    (n) =>
      (role == null || n.role === role) &&
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
