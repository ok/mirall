// Turns the flat ShareFileEntry[] list from useShareFiles into a nested folder/file
// tree for the collapsible FolderScreen. Plain JS (no React, no bare-*/node imports) so
// the same source feeds the esbuild renderer bundle AND the brittle-node unit suite,
// which imports .js from src/renderer directly. Node shapes are typed in types.ts.

// Coarse category for folder roll-up summaries. Anything unlisted — a new status included —
// falls through to 'available', so a status that needs its own bucket must be added here.
/** @import { FileTreeFileNode, FileTreeFolderNode, FileTreeNode, FileTreeStatusCategory, ShareFileEntry, ShareFileStatus } from '../types/types.js' */

/** @typedef {FileTreeFolderNode & { _folders: Map<string, BuildingFolder>, _files: FileTreeFileNode[] }} BuildingFolder */

/** @internal @param {ShareFileStatus} status @returns {FileTreeStatusCategory} */
export function statusCategory(status) {
  switch (status) {
    case 'downloaded':
    case 'synced':
    case 'modified':
      return 'on-device'
    case 'downloading':
    case 'verifying':
      return 'downloading'
    // The owner indexing a file ('publishing') and a member waiting on that index ('preparing')
    // are not transfers: rolled into 'downloading' they made a folder nobody was pulling from
    // report "N downloading".
    case 'preparing':
    case 'publishing':
      return 'preparing'
    case 'paused-interrupted':
    case 'paused-offline':
      return 'paused'
    case 'error':
      return 'error'
    default:
      return 'available'
  }
}

/** @returns {Record<FileTreeStatusCategory, number>} */
function emptyCounts() {
  return { 'on-device': 0, downloading: 0, preparing: 0, available: 0, paused: 0, error: 0 }
}

// relPath → clean segment list. Tolerant of backslashes and leading/trailing slashes.
/** @param {string} relPath */
function splitSegments(relPath) {
  return String(relPath)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
}

/** @param {string} a @param {string} b */
const cmpName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

// Exported as rollupNodes so a filtered tree can re-derive the aggregates for a folder whose
// children it pruned: the counts, the size and the status pills a folder row prints all describe
// the children it actually has.
/** @param {FileTreeNode[]} children */
export function rollupNodes(children) {
  let fileCount = 0
  let totalBytes = 0
  let folderCount = 0
  const statusCounts = emptyCounts()
  for (const c of children) {
    if (c.kind === 'file') {
      fileCount += 1
      totalBytes += c.entry.size || 0
      statusCounts[statusCategory(c.entry.status)] += 1
    } else {
      folderCount += 1 + c.folderCount
      fileCount += c.fileCount
      totalBytes += c.totalBytes
      for (const k of /** @type {FileTreeStatusCategory[]} */ (Object.keys(statusCounts))) statusCounts[k] += c.statusCounts[k]
    }
  }
  return { fileCount, totalBytes, folderCount, statusCounts }
}

/** @param {string} name @param {string} path @param {number} depth @returns {BuildingFolder} */
function makeFolder(name, path, depth) {
  return { kind: 'folder', name, path, depth, children: [], fileCount: 0, folderCount: 0, totalBytes: 0, statusCounts: emptyCounts(), _folders: new Map(), _files: [] }
}

// Sort children (folders first), roll up aggregates bottom-up, drop scratch fields.
/** @param {BuildingFolder} folder @returns {FileTreeFolderNode} */
function finalize(folder) {
  const { _folders, _files, ...node } = folder
  const folders = [..._folders.values()].map(finalize).sort((a, b) => cmpName(a.name, b.name))
  const filesSorted = _files.sort((a, b) => cmpName(a.name, b.name))
  const children = [...folders, ...filesSorted]
  return { ...node, children, ...rollupNodes(children) }
}

// Build a nested tree from a flat entry list. Folders sort before files; both
// alphanumeric + case-insensitive. Entries with an empty/invalid relPath are skipped.
/** @param {readonly ShareFileEntry[] | null | undefined} files @returns {FileTreeNode[]} */
export function buildFileTree(files) {
  const root = makeFolder('', '', -1)
  for (const entry of files ?? []) {
    if (!entry || typeof entry.relPath !== 'string') continue
    const segs = splitSegments(entry.relPath)
    if (segs.length === 0) continue
    let parent = root
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]
      let next = parent._folders.get(seg)
      if (!next) {
        const path = parent.path ? `${parent.path}/${seg}` : seg
        next = makeFolder(seg, path, parent.depth + 1)
        parent._folders.set(seg, next)
      }
      parent = next
    }
    parent._files.push({
      kind: 'file',
      name: segs[segs.length - 1],
      path: entry.relPath,
      depth: parent.depth + 1,
      entry
    })
  }
  return finalize(root).children
}

// All folder paths in the tree (depth-first) — for "expand all" + "is everything open?".
/** @param {FileTreeNode[]} nodes @returns {string[]} */
export function collectFolderPaths(nodes) {
  /** @type {string[]} */
  const out = []
  /** @param {FileTreeNode[]} list */
  const walk = (list) => {
    for (const n of list) {
      if (n.kind === 'folder') { out.push(n.path); walk(n.children) }
    }
  }
  walk(nodes)
  return out
}

// Top-level folder paths only (the default-expanded set).
/** @param {FileTreeNode[]} nodes */
export function topLevelFolderPaths(nodes) {
  return nodes.filter((n) => n.kind === 'folder').map((n) => n.path)
}
