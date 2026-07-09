// Spaces whose last interactive listing gave up on ≥1 peer catalog under the read budget.
// The listing's documented self-heal ("re-lists on the peer's next append") never fires when
// the replication stream is stalled — the convergence tick drains this set and re-pokes
// files-updated as the level-triggered backstop. Take-semantics: a space that stops
// re-flagging stops being poked.
const incompleteListSpaces = new Set()

export function markListIncomplete (spaceId) {
  if (spaceId) incompleteListSpaces.add(spaceId)
}

export function takeIncompleteListSpaces () {
  const out = [...incompleteListSpaces]
  incompleteListSpaces.clear()
  return out
}

export function clearListDeficits () {
  incompleteListSpaces.clear()
}
