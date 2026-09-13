// Path rules every runtime shares. They live here because `core/` may not import `folders/` and
// `folders/` may not import `transfer/` — the two edges those rules were being read across.

// A file's own suffix while it is still being written. The vendored overlay engine keeps its own
// default for the same idea; PROVENANCE.md records the divergence and a test pins that no
// non-vendor module re-declares this one.
export const PARTIAL_SUFFIX = '.mirall.part'

export const partialPathFor = (targetPath) => targetPath + PARTIAL_SUFFIX

// The order the publish queue drains in. Named here so the config that validates the setting and
// the queue that implements it cannot disagree.
export const PUBLISH_ORDERS = Object.freeze(['fifo', 'smallest-first', 'largest-first'])

// True when `child` is `parent` or sits inside it. The separator boundary prevents the classic
// false positive: `/a/bc` is not inside `/a/b`. `fold` compares case-insensitively, for the
// filesystems that case-fold (darwin/win32).
export function pathContains(parent, child, sep, fold = false) {
  if (!parent || !child) return false
  let root = fold ? parent.toLowerCase() : parent
  while (root.length > 1 && root.endsWith(sep)) root = root.slice(0, -1)
  const c = fold ? child.toLowerCase() : child
  if (c === root) return true
  // A filesystem root ("/", "C:\") already ends in the separator; appending a second one would make
  // every child miss.
  return c.startsWith(root.endsWith(sep) ? root : root + sep)
}
