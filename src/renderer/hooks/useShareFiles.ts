// A folder share's file listing. The query store holds the raw share:list-files response; this hook
// keeps the parts that are judgements about what a folder listing MEANS — the never-blank fold
// across successive reads, the header totals derived from both, and which failures are terminal —
// and hands out the per-row decoration lookups the rows derive their lane from.
import { useState, useCallback, useMemo } from 'react'
import { request } from '../ipc/ipc.js'
import { revealOnClient } from '../platform/reveal-client.js'
import { useQuery } from '../store/useQuery.js'
import { foldListing, emptyFold, resolveListing, type Fold } from '../model/share-files-fold.js'
import { shareDecoKey } from '../../shared/contract/decoration-key.js'
import { useDecorations } from './useDecorations.js'
import { useRunAction } from './useRunAction.js'

export function useShareFiles(spaceId: string, ownerKey: string, shareId: string) {
  const { byKey: decorations } = useDecorations('transfer', spaceId, shareDecoKey(shareId, ''))
  const run = useRunAction()

  // The share's own listing; a space-wide transition (presence, roster), which changes row status
  // without touching the catalog, reaches it as the wildcard (README.md).
  const scopes = useMemo(
    () => [{ kind: 'share-files', spaceId, shareId }],
    [spaceId, shareId],
  )
  const ready = Boolean(spaceId && shareId && ownerKey)
  // The store holds the RAW response. It never learns what `complete` or `truncated` mean — those
  // are share:list-files concepts, and the fold below is where they are read.
  const { data, error: queryError, loading: fetching } = useQuery(
    'share:list-files',
    { spaceId, ownerKey, shareId },
    scopes,
    { coalesceMs: 750, enabled: ready },
  )

  // The fold across responses, advanced DURING RENDER: reconcileFiles needs the previous reconciled
  // list, which the store does not hold. State updated conditionally in render is React's documented
  // carry; an effect would be derived-state-in-effect, and a memo has no memory of its own output.
  const [fold, setFold] = useState<Fold>(emptyFold)
  // Paths whose download was just requested. An override rather than a write into the list: seeded
  // into the rows it would be dropped by the next refetch, and the seed exists only to cover the
  // gap before the first decoration frame arrives.
  const [seeded, setSeeded] = useState<ReadonlySet<string>>(new Set())

  if (data && data !== fold.res) setFold(foldListing(fold, data))

  const { rows: files, info, error } = resolveListing(fold, queryError as (Error & { code?: string }) | null)
  // Cold only (README.md).
  const loading = ready && fold.res === null && fetching && !queryError

  // An accessor, not a merged field: merging built a NEW row object every frame, which rebuilt the
  // whole tree and re-ran the filter walk — two O(n) passes per frame for one row's lane. Which
  // phase a frame may paint is rowView.js's judgement. useCallback because FolderScreen's mirrorSync
  // memo takes this as a dependency, so it must change exactly when the decorations do (README.md).
  const getDecoration = useCallback(
    (relPath: string) => decorations.get(shareDecoKey(shareId, relPath)) ?? null,
    [decorations, shareId],
  )
  const isSeeded = useCallback((relPath: string) => seeded.has(relPath), [seeded])

  // Pause and cancel are useTransferControls', shared with the space screen.
  const downloadFile = useCallback(
    (relPath: string) => run(async () => {
      const res = await request('share:read-file', { spaceId, ownerKey, shareId, relPath })
      // The union is the point: a read that was already ours, synced by a mirror, or queued behind
      // the download engine starts no transfer and seeds no bar.
      if (!('transferId' in res)) return
      // Seed the progress bar; the row's status flips to 'downloading' from the worker's re-derive
      // (the engine emits share-files-updated on start), not a client override.
      setSeeded((prev) => { const next = new Set(prev); next.add(relPath); return next })
    }),
    [run, spaceId, ownerKey, shareId]
  )

  const revealFile = useCallback(
    (relPath: string) => run(async () => revealOnClient(await request('share:reveal-file', { spaceId, ownerKey, shareId, relPath }))),
    [run, spaceId, ownerKey, shareId]
  )

  return { files, info, loading, error, getDecoration, isSeeded, downloadFile, revealFile }
}
