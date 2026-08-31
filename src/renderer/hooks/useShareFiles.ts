// A folder share's file listing. The query store holds the raw share:list-files response; this hook
// keeps the parts that are judgements about what a folder listing MEANS — the never-blank fold
// across successive reads, the header totals derived from both, and which failures are terminal —
// and paints per-file progress from the decoration channel at render.
import { useState, useCallback, useMemo } from 'react'
import { request } from '../ipc.js'
import { useQuery } from '../store/useQuery.js'
import { refetchQuery } from '../store/query-store.js'
import { foldListing, emptyFold, resetFold, resolveListing, type Fold } from '../shareFilesFold.js'
import { shareDecoKey } from '../decoration-key.js'
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

export function useShareFiles(spaceId: string, ownerKey: string, shareId: string, _role: 'mine' | 'browse' | 'mirrored') {
  const { byKey: decorations } = useDecorations('transfer', spaceId, shareDecoKey(shareId, ''))

  // Two scopes feed this view: the share's own rows, and the space's peer/presence transitions,
  // which change row status (remote/unavailable, paused-offline) without touching the catalog.
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

  // The fold across successive responses, advanced DURING RENDER. reconcileFiles needs the previous
  // reconciled list, which the store cannot supply — it holds the latest answer, not the history.
  // React's documented way to carry a value between renders is to hold it in state and update it
  // conditionally here; an effect would be the derived-state-in-effect anti-pattern, a memo has no
  // memory of its own output, and a ref written in render is not a render input.
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
  // Only a genuinely cold share reports loading; a hint-driven refetch keeps the rows and the
  // scroll position.
  const loading = ready && fold.res === null && fetching && !queryError

  const refresh = useCallback(async () => {
    if (!ready) return
    await refetchQuery<ListResult>('share:list-files', { spaceId, ownerKey, shareId }, scopes).catch(() => {})
  }, [ready, spaceId, ownerKey, shareId, scopes])

  // Per-file transfer progress rides the unified decoration channel (keyed shareId:relPath) and is
  // merged at render — never into the list state, so a late frame can't outlive a refresh. The gate
  // on the worker-derived status keeps a lingering decoration (missed `done`) invisible: a row that
  // is no longer downloading/verifying simply stops rendering it. `decorations` is prefix-scoped to
  // this share, so the memo recomputes only for this share's frames or a fresh listing.
  const decorated = useMemo(() => files.map((f) => {
    const d = decorations.get(shareDecoKey(shareId, f.relPath))
    // The seed only paints while there is no real frame yet and the row has not left the transfer
    // states — a decoration, or any other status, outranks it.
    if (!d && seeded.has(f.relPath) && (f.status === 'downloading' || f.status === 'preparing')) {
      return { ...f, progress: { bytes: f.pendingBytes ?? 0, total: f.size, speed: 0, eta: null } }
    }
    if (!d) return f
    // Match the decoration phase to the row's status: the shared key has no receiver-side terminal
    // done, so a lingering cross-phase frame (a preparing frame left on a now-downloading row) must
    // not paint the wrong bar. A downloading row takes only a download/verify frame; a preparing row
    // only a preparing frame.
    if (f.status === 'downloading') {
      if (d.phase === 'verifying') {
        return { ...f, verifyFraction: d.verifyFraction ?? 0, progress: { bytes: d.bytes, total: f.size, speed: 0, eta: null, phase: 'verifying' as const } }
      }
      if (d.phase == null) {
        return { ...f, verifyFraction: undefined, progress: { bytes: d.bytes, total: d.total, speed: d.speed, avgSpeed: d.avgSpeed, eta: d.eta } }
      }
      return f
    }
    if (f.status === 'preparing' && d.phase === 'preparing') {
      return { ...f, verifyFraction: undefined, progress: { bytes: d.bytes, total: d.total, speed: 0, eta: d.eta } }
    }
    return f
  }), [files, decorations, shareId, seeded])

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

  return { files: decorated, info, loading, error, refresh, downloadFile, revealFile, pauseDownload, cancelDownload, discardPartial }
}
