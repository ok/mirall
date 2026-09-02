// Case-insensitive filter over a built file tree (fileTree.js). Plain JS, no React, so the same
// source feeds the esbuild bundle and the brittle-node unit suite. Node shapes are typed in
// types.ts; the .d.ts sibling declares this module's surface.
//
// A folder that matches keeps its whole subtree — filtering "Ninja Tune" should not then hide the
// tracks inside it. A folder that does not match survives only through its descendants, which is
// what keeps a deep hit reachable.

import { collectFolderPaths, rollupNodes } from './fileTree.js'

// Revealing every matched branch is "Expand all, on every keystroke", so it is gated on the size of
// the result rather than on the length of the term: a term that matches almost everything (typing a
// single "e" into a 5,000-file folder) leaves the branches closed, which is both cheap to render and
// the only readable way to show that many hits. A precise term reveals, which is the point of it.
const REVEAL_MAX_MATCHES = 200

function matches (name, needle) {
  return name.toLowerCase().includes(needle)
}

function countFiles (nodes) {
  let total = 0
  for (const node of nodes) {
    if (node.kind === 'file') total += 1
    else total += node.fileCount
  }
  return total
}

function filterNodes (nodes, needle, revealPaths) {
  const out = []
  for (const node of nodes) {
    if (node.kind === 'file') {
      if (matches(node.name, needle)) out.push(node)
      continue
    }
    if (matches(node.name, needle)) {
      out.push(node)
      revealPaths.add(node.path)
      for (const path of collectFolderPaths(node.children)) revealPaths.add(path)
      continue
    }
    const children = filterNodes(node.children, needle, revealPaths)
    if (children.length === 0) continue
    revealPaths.add(node.path)
    // The roll-ups are re-derived, never copied: a folder row prints its own file count, size and
    // status pills, and carrying the unfiltered numbers would put "500 files · 12 GB" on a row that
    // is showing one match, directly under a controls row that correctly says "1 of 500".
    out.push({ ...node, children, ...rollupNodes(children) })
  }
  return out
}

// `revealPaths` is null when no filter is active, which is the signal the caller uses to fall back
// to the user's own expansion — and it is null again for a result too large to reveal, so the
// caller treats both the same way.
export function filterTree (nodes, term) {
  const needle = String(term || '').trim().toLowerCase()
  if (!needle) return { nodes, matched: null, revealPaths: null }
  const revealPaths = new Set()
  const filtered = filterNodes(nodes, needle, revealPaths)
  const matched = countFiles(filtered)
  return {
    nodes: filtered,
    matched,
    revealPaths: matched <= REVEAL_MAX_MATCHES ? revealPaths : null,
  }
}
