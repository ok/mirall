import type { ShareFileEntry } from './types.js'

export interface ListResult {
  entries: unknown[]
  complete: boolean
  total?: number
  totalBytes?: number
  truncated?: boolean
  fileLimit?: number | null
}

export interface FolderInfo {
  fileCount: number
  totalBytes: number
  blobsLength: number | null
  truncated: boolean
  fileLimit: number | null
}

export interface Fold {
  res: ListResult | null
  rows: ShareFileEntry[]
  info: FolderInfo | null
}

export declare const emptyFold: Fold
export declare function foldListing (prev: Fold, res: ListResult | null, toEntry: (entry: never) => ShareFileEntry): Fold
export declare function resetFold (): Fold

export interface ResolvedListing {
  rows: ShareFileEntry[]
  info: FolderInfo | null
  error: string | null
  terminal: boolean
}

export declare function resolveListing (fold: Fold, error: (Error & { code?: string }) | null): ResolvedListing
