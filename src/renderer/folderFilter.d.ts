import type { FileTreeNode } from './types.js'

export interface FilteredTree {
  nodes: FileTreeNode[]
  matched: number | null
  revealPaths: Set<string> | null
}

export function filterTree(nodes: FileTreeNode[], term: string): FilteredTree
