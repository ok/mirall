// Multi-select over a listing: a Set of row keys, the visible order a shift-range walks, and the
// one rule table every pointer and box gesture goes through. A folder row is never a key: its box
// stands for the matching files below it, so its state is derived. Keys of rows that left the
// listing are ignored by every read, never by mutation, so a selection survives a filter change.
// Pure, so test/unit drives it under plain Node.
/** @import { FileTreeNode } from '../types/types.js' */

/** @typedef {'on' | 'off' | 'mixed'} TriState */
/** @typedef {'toggle' | 'toggle-mod' | 'range'} Gesture */
/** @typedef {{ mode: boolean, selected: ReadonlySet<string>, anchor: string | null }} SelectionState */
/** @typedef {{ order: readonly string[], filesUnder: (path: string) => readonly string[], matching: ReadonlySet<string> }} SelectionContext */
// `inProgress` is a row with a transfer under way: selectable, so a row that starts while ticked
// keeps its box, but no strip verb acts on it; its own row cancels it.
/** @typedef {{ download: boolean, inProgress: boolean, unshare: boolean, onDevice: boolean }} BatchVerbs */
/**
 * @template T
 * @typedef {{ count: number, bytes: number, hidden: number, onDevice: number, download: T[], unshare: T[] }} SelectionSummary
 */

/** @type {ReadonlySet<string>} */
const NO_SELECTION = new Set()
// A relPath never starts with '/' and a loose key starts with its owner's hex, so neither can
// collide with these ids.
export const TOP_BOX = '/:all'
const DIR_PREFIX = '/:dir:'

/** @type {SelectionState} */
export const AT_REST = Object.freeze({ mode: false, selected: NO_SELECTION, anchor: null })

/** @param {readonly string[]} keys @param {ReadonlySet<string>} selected @returns {TriState} */
export function triState(keys, selected) {
  if (keys.length === 0) return 'off'
  let n = 0
  for (const k of keys) if (selected.has(k)) n += 1
  return n === 0 ? 'off' : n === keys.length ? 'on' : 'mixed'
}

/**
 * A box's click: on unless every key under it is already on.
 * @param {ReadonlySet<string>} selected @param {readonly string[]} keys @param {boolean} [on]
 * @returns {ReadonlySet<string>}
 */
export function toggleKeys(selected, keys, on = triState(keys, selected) !== 'on') {
  const next = new Set(selected)
  for (const k of keys) on ? next.add(k) : next.delete(k)
  return next
}

/** @param {string} path */
export const dirId = (path) => DIR_PREFIX + path

/** @param {string} id */
const isDirId = (id) => id.startsWith(DIR_PREFIX)

/**
 * The modifier a click carries: shift extends a range, the platform command key toggles without
 * opening the column first.
 * @param {{ shiftKey: boolean, metaKey: boolean, ctrlKey: boolean }} e
 * @returns {Gesture}
 */
export function gestureOf(e) {
  if (e.shiftKey) return 'range'
  return e.metaKey || e.ctrlKey ? 'toggle-mod' : 'toggle'
}

/**
 * The visible order of a filtered tree: depth-first, collapsed folders skipped. Folder ids are
 * prefixed so a range that crosses a folder row takes that folder's matching files.
 * @param {readonly FileTreeNode[]} nodes @param {(path: string) => boolean} isExpanded @param {string[]} [out]
 * @returns {string[]}
 */
export function visibleOrder(nodes, isExpanded, out = []) {
  for (const n of nodes) {
    if (n.kind === 'folder') {
      out.push(dirId(n.path))
      if (isExpanded(n.path)) visibleOrder(n.children, isExpanded, out)
    } else out.push(n.path)
  }
  return out
}

/**
 * Every file key in a tree, the selectable ones among them, and per folder path the selectable
 * keys below it. One walk answers the top box, each folder box and a range across a folder row.
 * @param {readonly FileTreeNode[]} nodes @param {(key: string) => boolean} [selectable]
 * @returns {{ shown: Set<string>, keys: Set<string>, under: Map<string, string[]> }}
 */
export function collectTreeKeys(nodes, selectable = () => true) {
  /** @type {Set<string>} */
  const shown = new Set()
  /** @type {Set<string>} */
  const keys = new Set()
  /** @type {Map<string, string[]>} */
  const under = new Map()
  /** @param {readonly FileTreeNode[]} list @returns {string[]} */
  const walk = (list) => {
    /** @type {string[]} */
    const out = []
    for (const n of list) {
      if (n.kind === 'folder') {
        const below = walk(n.children)
        under.set(n.path, below)
        out.push(...below)
        continue
      }
      shown.add(n.path)
      if (selectable(n.path)) {
        keys.add(n.path)
        out.push(n.path)
      }
    }
    return out
  }
  walk(nodes)
  return { shown, keys, under }
}

/**
 * The keys a box or a range end stands for: a file is itself, a folder is its matching files. A
 * file outside the matching set (nothing a batch can do with it) stands for nothing, so a click on
 * its row or a range across it never ticks a key the user cannot see.
 * @param {string} id @param {SelectionContext} ctx @returns {readonly string[]}
 */
export function keysFor(id, { filesUnder, matching }) {
  if (isDirId(id)) return filesUnder(id.slice(DIR_PREFIX.length)).filter((key) => matching.has(key))
  return matching.has(id) ? [id] : []
}

/**
 * A shift-click: everything between the anchor and the target, inclusive, is turned ON. No anchor,
 * or an anchor that left the visible order: the target alone.
 * @param {string | null} anchor @param {string} to @param {SelectionContext} ctx
 * @returns {readonly string[]}
 */
export function rangeKeys(anchor, to, ctx) {
  const { order } = ctx
  const a = anchor == null ? -1 : order.indexOf(anchor)
  const b = order.indexOf(to)
  if (a < 0 || b < 0) return keysFor(to, ctx)
  const [lo, hi] = a < b ? [a, b] : [b, a]
  return order.slice(lo, hi + 1).flatMap((id) => keysFor(id, ctx))
}

/**
 * The next state for a gesture on one target, or null when the gesture is not a selection gesture
 * there, so the caller runs the target's own click (a folder row expands). The top box opens the
 * column with every matching file on its first tick and toggles all of them after that. At rest
 * only a modified click opens the column; while selecting a plain click toggles, a shift-click
 * extends the range from the last toggled target, which stays the anchor.
 * @param {SelectionState} state @param {string} id @param {Gesture} gesture @param {SelectionContext} ctx
 * @returns {SelectionState | null}
 */
export function nextSelection(state, id, gesture, ctx) {
  const all = [...ctx.matching]
  if (id === TOP_BOX) {
    if (!state.mode) return { mode: true, selected: toggleKeys(state.selected, all, true), anchor: null }
    return { ...state, selected: toggleKeys(state.selected, all) }
  }
  if (!state.mode && gesture !== 'toggle-mod') return null
  if (state.mode && gesture === 'range') {
    const keys = rangeKeys(state.anchor, id, ctx)
    return keys.length === 0 ? null : { ...state, selected: toggleKeys(state.selected, keys, true) }
  }
  const keys = keysFor(id, ctx)
  if (keys.length === 0) return null
  return { mode: true, selected: toggleKeys(state.selected, keys), anchor: id }
}

/** @param {SelectionState} state @param {ReadonlySet<string>} matching @returns {SelectionState} */
export function selectAllMatching(state, matching) {
  return { ...state, mode: true, selected: toggleKeys(state.selected, [...matching], true) }
}

/**
 * "Deselect hidden": keep only what the filter shows.
 * @param {ReadonlySet<string>} selected @param {ReadonlySet<string>} matching @returns {ReadonlySet<string>}
 */
export function keepMatching(selected, matching) {
  return new Set([...selected].filter((k) => matching.has(k)))
}

/**
 * What the strip says and which verbs it offers. `verbsOf` is file-row-action's batchVerbsFor, so
 * a batch verb exists exactly where the row's own button does. A selected key whose row left the
 * listing counts for nothing. `shown` is what the filter lets through, which is what "hidden"
 * means; a ticked row that merely lost its verb is still shown.
 * @template T
 * @param {{ rows: readonly T[], keyOf: (row: T) => string, sizeOf: (row: T) => number, selected: ReadonlySet<string>, shown: ReadonlySet<string>, verbsOf: (row: T) => BatchVerbs }} input
 * @returns {SelectionSummary<T>}
 */
export function summarize({ rows, keyOf, sizeOf, selected, shown, verbsOf }) {
  /** @type {SelectionSummary<T>} */
  const out = { count: 0, bytes: 0, hidden: 0, onDevice: 0, download: [], unshare: [] }
  for (const row of rows) {
    const key = keyOf(row)
    if (!selected.has(key)) continue
    out.count += 1
    out.bytes += sizeOf(row)
    if (!shown.has(key)) out.hidden += 1
    const v = verbsOf(row)
    if (v.download) out.download.push(row)
    if (v.unshare) out.unshare.push(row)
    if (v.onDevice) out.onDevice += 1
  }
  return out
}
