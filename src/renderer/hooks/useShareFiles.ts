// Owns a folder share's file listing (never-blank reconcile, latest-wins reads, coalesced refreshes) plus per-file transfer/prepare progress; re-derives on reconcile hints, paints progress from the decoration channel.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { request, subscribe } from '../ipc.js'
import { reconcileFiles } from '../shareFilesReconcile.js'
import { deriveFolderInfo } from '../folderInfo.js'
import { makeCoalescer } from '../coalesce.js'
import { Scope, scopeMatches, type Scope as ScopeType } from '../scope.js'
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

export function useShareFiles(spaceId: string, ownerKey: string, shareId: string, _role: 'mine' | 'browse' | 'mirrored') {
  const [files, setFiles] = useState<ShareFileEntry[]>([])
  const [info, setInfo] = useState<FolderInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const seqRef = useRef(0)
  const filesRef = useRef<ShareFileEntry[]>([])
  const { byKey: decorations } = useDecorations('transfer', spaceId, shareDecoKey(shareId, ''))

  const refresh = useCallback(async () => {
    if (!spaceId || !shareId || !ownerKey) return
    const seq = ++seqRef.current
    try {
      const res = await request('share:list-files', { spaceId, ownerKey, shareId }) as ListResult
      if (seq !== seqRef.current) return
      const mapped: ShareFileEntry[] = res.entries.map((e) => ({
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
      }))
      // One read carries both the rows and their completeness; an incomplete/partial peer
      // read must not blank or shrink the list (reconcileFiles keeps the last good rows).
      const next: ShareFileEntry[] = reconcileFiles(filesRef.current, mapped, { complete: res.complete })
      filesRef.current = next
      setFiles(next)
      // On a complete read fileCount is the TRUE total (res.total) and `next` may be capped to
      // listFilesCap, which the over-limit banner reports; on an incomplete read the count can only
      // rise above the reconciled rows, never fall below them. (see deriveFolderInfo)
      setInfo(deriveFolderInfo(res, next))
      setError(null)
    } catch (err) {
      if (seq !== seqRef.current) return
      const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined
      // A timeout / peer-unavailable read is transient → keep the last good list. A gone or
      // access-revoked share (NOT_FOUND / EOWNERSHIP) is terminal → clear and surface it so a
      // deleted share doesn't linger as a phantom listing.
      const terminal = code === 'NOT_FOUND' || code === 'EOWNERSHIP'
      if (filesRef.current.length > 0 && !terminal) {
        setError(null)
      } else {
        filesRef.current = []
        setFiles([])
        setInfo(null)
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [spaceId, ownerKey, shareId])

  useEffect(() => {
    // Reset list state when the share changes so the never-blank merge can't carry the
    // previous share's rows into this one (FolderView is reused, not keyed per share).
    filesRef.current = []
    setFiles([])
    setInfo(null)
    setError(null)
    // Loading state only on first load / when the share changes — not on the
    // event-driven refreshes below, which would otherwise collapse the list and
    // reset scroll position (e.g. after downloading a file).
    setLoading(true)
    // Coalesce the per-append refresh storm during a large index into one trailing
    // refresh per window; the first load is immediate.
    const coalescer = makeCoalescer(() => { void refresh() }, { intervalMs: 750 })
    void refresh()
    // Level-triggered: two scopes feed this view — the share's own rows (share-files) and the
    // space's peer/presence transitions (files), which affect row status (remote/unavailable,
    // paused-offline/-interrupted) without touching the share catalog.
    const unsubReconcile = subscribe<{ scope: ScopeType }>('event:reconcile', (msg) => {
      if (scopeMatches(msg.scope, Scope.shareFiles(spaceId, shareId)) ||
          scopeMatches(msg.scope, Scope.files(spaceId))) coalescer.trigger()
    })
    return () => { coalescer.cancel(); unsubReconcile() }
  }, [refresh, spaceId, shareId])

  // Per-file transfer progress rides the unified decoration channel (keyed shareId:relPath) and is
  // merged at render — never into the list state, so a late frame can't outlive a refresh. The gate
  // on the worker-derived status keeps a lingering decoration (missed `done`) invisible: a row that
  // is no longer downloading/verifying simply stops rendering it. `decorations` is prefix-scoped to
  // this share, so the memo recomputes only for this share's frames or a fresh listing.
  const decorated = useMemo(() => files.map((f) => {
    const d = decorations.get(shareDecoKey(shareId, f.relPath))
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
  }), [files, decorations, shareId])

  const downloadFile = useCallback(
    async (relPath: string) => {
      const res = await request('share:read-file', { spaceId, ownerKey, shareId, relPath }) as DownloadFileResult
      const transferId = res?.transferId
      if (!transferId) return
      // Seed the progress bar; the row's status flips to 'downloading' from the worker's re-derive
      // (the engine emits share-files-updated on start), not a client override.
      setFiles((prev) => prev.map((f) => (
        f.relPath === relPath
          ? { ...f, progress: { bytes: f.pendingBytes ?? 0, total: f.size, speed: 0, eta: null } }
          : f
      )))
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
