// A folder share's file listing. The query store holds the raw share:list-files response; this hook
// keeps the parts that are judgements about what a folder listing MEANS — the never-blank fold
// across successive reads, the header totals derived from both, and which failures are terminal —
// and hands out the per-row decoration lookups the rows derive their lane from.
import { useState, useCallback, useMemo } from 'react'
import { request } from '../ipc.js'
import { useQuery } from '../store/useQuery.js'
import { foldListing, emptyFold, resetFold, resolveListing, type Fold } from '../shareFilesFold.js'
import { shareDecoKey } from '../../shared/contract/decoration-key.js'
import { useDecorations } from './useDecorations.js'
import type { ShareFileEntry, ShareFileStatus } from '../types.js'

interface ServerEntry {
  relPath: string
  size: number
  hash: string
  mtime: number
  status: ShareFileStatus
  localPath: string | null
  verified?: boolean
  pendingBytes?: number
  errorCode?: string
  transferId?: string
}

interface DownloadFileResult {
  transferId?: string
  queued?: boolean
  alreadyOwned?: boolean
}

interface FolderInfo {
  fileCount: number
  totalBytes: number
  blobsLength: number | null
  truncated: boolean
  fileLimit: number | null
}

interface ListResult {
  entries: ServerEntry[]
  complete: boolean
  // True folder totals — `entries` is capped at listFilesCap to bound the worker heap,
  // so these (streamed separately) report the real count past the cap. Absent for backends
  // that don't cap → fall back to the row count.
  total?: number
  totalBytes?: number
  // Whether the worker capped the rows. Reported, never inferred: see deriveFolderInfo.
  truncated?: boolean
  // The limit the rows were capped at — non-null exactly when `truncated`.
  fileLimit?: number | null
}

function toEntry(e: ServerEntry): ShareFileEntry {
  return {
    relPath: e.relPath,
    size: e.size,
    hash: e.hash,
    mtime: e.mtime,
    status: e.status,
    localPath: e.localPath ?? undefined,
    verified: e.verified,
    pendingBytes: e.pendingBytes,
    errorCode: e.errorCode,
    transferId: e.transferId,
  }
}

export function useShareFiles(spaceId: string, ownerKey: string, shareId: string) {
  const { byKey: decorations } = useDecorations('transfer', spaceId, shareDecoKey(shareId, ''))

  // The share's own rows, plus the space's peer/presence transitions, which change row status
  // without touching the catalog (README.md).
  const scopes = useMemo(
    () => [{ kind: 'share-files', spaceId, shareId }, { kind: 'files', spaceId }],
    [spaceId, shareId],
  )
  const ready = Boolean(spaceId && shareId && ownerKey)
  // The store holds the RAW response. It never learns what `complete` or `truncated` mean — those
  // are share:list-files concepts, and the fold below is where they are read.
  const { data, error: queryError, loading: fetching } = useQuery<ListResult>(
    'share:list-files',
    { spaceId, ownerKey, shareId },
    scopes,
    { coalesceMs: 750, enabled: ready },
  )

  // The fold across responses, advanced DURING RENDER: reconcileFiles needs the previous reconciled
  // list, which the store does not hold. State updated conditionally in render is React's documented
  // carry; an effect would be derived-state-in-effect, and a memo has no memory of its own output.
  const [fold, setFold] = useState<Fold>(emptyFold)
  const [foldedShare, setFoldedShare] = useState(shareId)
  // Paths whose download was just requested. An override rather than a write into the list: seeded
  // into the rows it would be dropped by the next refetch, and the seed exists only to cover the
  // gap before the first decoration frame arrives.
  const [seeded, setSeeded] = useState<ReadonlySet<string>>(new Set())

  if (foldedShare !== shareId) {
    // FolderView is reused, not keyed per share, so the previous share's rows must not merge in.
    setFoldedShare(shareId)
    setFold(resetFold())
  } else if (data && data !== fold.res) {
    setFold(foldListing(fold, data, toEntry))
  }

  const { rows: files, info, error } = resolveListing(fold, queryError as (Error & { code?: string }) | null)
  // Cold only (README.md).
  const loading = ready && fold.res === null && fetching && !queryError

  // An accessor, not a merged field: merging built a NEW row object every frame, which rebuilt the
  // whole tree and re-ran the filter walk — two O(n) passes per frame for one row's lane. Which
  // phase a frame may paint is rowView.js's judgement. useCallback because FolderView's mirrorSync
  // memo takes this as a dependency, so it must change exactly when the decorations do (README.md).
  const getDecoration = useCallback(
    (relPath: string) => decorations.get(shareDecoKey(shareId, relPath)) ?? null,
    [decorations, shareId],
  )
  const isSeeded = useCallback((relPath: string) => seeded.has(relPath), [seeded])

  const downloadFile = useCallback(
    async (relPath: string) => {
      const res = await request('share:read-file', { spaceId, ownerKey, shareId, relPath }) as DownloadFileResult
      const transferId = res?.transferId
      if (!transferId) return
      // Seed the progress bar; the row's status flips to 'downloading' from the worker's re-derive
      // (the engine emits share-files-updated on start), not a client override.
      setSeeded((prev) => { const next = new Set(prev); next.add(relPath); return next })
    },
    [spaceId, ownerKey, shareId]
  )

  const revealFile = useCallback(
    async (relPath: string) => {
      await request('share:reveal-file', { spaceId, ownerKey, shareId, relPath })
    },
    [spaceId, ownerKey, shareId]
  )

  const pauseDownload = useCallback(async (transferId: string) => {
    await request('files:pause-download', { transferId })
  }, [])

  const cancelDownload = useCallback(async (transferId: string) => {
    await request('files:cancel-download', { transferId })
  }, [])

  const discardPartial = useCallback(async (relPath: string) => {
    await request('share:discard-partial', { spaceId, ownerKey, shareId, relPath })
  }, [spaceId, ownerKey, shareId])

  return { files, info, loading, error, getDecoration, isSeeded, downloadFile, revealFile, pauseDownload, cancelDownload, discardPartial }
}
