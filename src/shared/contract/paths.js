// Path rules every runtime shares. They live here because `core/` may not import `folders/` and
// `folders/` may not import `transfer/` — the two edges those rules were being read across.

// A file's own suffix while it is still being written. The vendored overlay engine keeps its own
// default for the same idea; PROVENANCE.md records the divergence and a test pins that no
// non-vendor module re-declares this one.
export const PARTIAL_SUFFIX = '.mirall.part'

/** @param {string} targetPath */
export const partialPathFor = (targetPath) => targetPath + PARTIAL_SUFFIX

// The order the publish queue drains in. Named here so the config that validates the setting and
// the queue that implements it cannot disagree.
export const PUBLISH_ORDERS = Object.freeze(/** @type {const} */ (['fifo', 'smallest-first', 'largest-first']))
/** @typedef {(typeof PUBLISH_ORDERS)[number]} PublishOrder */

// True when `child` is `parent` or sits inside it. The separator boundary prevents the classic
// false positive: `/a/bc` is not inside `/a/b`. `fold` compares case-insensitively, for the
// filesystems that case-fold (darwin/win32).
/** @param {string} parent @param {string} child @param {string} sep @param {boolean} [fold] */
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

// Whose filesystem a path on the wire belongs to. Every path-carrying payload the worker sends says
// so, because "an absolute path" stops meaning "a path I can open" the moment the backend runs
// somewhere else — and a client that guesses opens a coincidentally-existing local file of the same
// name, which is worse than opening nothing.
//
// 'daemon': a path on the machine the worker runs on. A client may display it; only the daemon may
//           open, reveal or stat it.
// 'client': a path on the client's own machine, which its shell may open.
//
// Request ARGUMENTS are deliberately untagged: a path sent TO the worker is an instruction about
// the worker's filesystem by definition. What breaks when the daemon is remote is not their tagging
// but their source — a folder picker returns a path on the machine running the picker — and that is
// a remote-browsing problem a discriminator would not solve.
export const PATH_HOST = Object.freeze({ DAEMON: 'daemon', CLIENT: 'client' })
/** @typedef {(typeof PATH_HOST)[keyof typeof PATH_HOST]} PathHost */

// The worker is the only process that touches the filesystem, so everything it sends is its own.
// Set honestly from the first commit rather than retrofitted when it stops being true.
/** @template {object} T @param {T} payload @returns {T & { host: 'daemon' }} */
export const daemonPaths = (payload) => ({ ...payload, host: PATH_HOST.DAEMON })
