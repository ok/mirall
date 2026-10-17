// Batch selection on a browse folder: which rows can be ticked, what the selection can do, the
// request a Download sends, and the strip of the batch it started. Only a browse folder offers it:
// an own or a mirrored folder's rows carry no verb a batch could act on. The pure rules live in
// model/batch-selection.js and model/batch-progress.js; this is the wiring.
import { useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc/ipc.js'
import { useToast } from '../components/toast/ToastProvider.js'
import { useRunAction } from './useRunAction.js'
import { useBatchSelection } from './useBatchSelection.js'
import { useSelectionKeys } from './useSelectionKeys.js'
import { useTransferControls } from './useTransferControls.js'
import { batchIsRecent, batchScope, clearDownloadBatch, startDownloadBatch, useDownloadBatch, type DownloadBatch } from './useDownloadBatch.js'
import { collectTreeKeys, summarize, visibleOrder } from '../model/batch-selection.js'
import { batchVerbsFor, isBatchSelectable } from '../model/file-row-action.js'
import { deriveDownloadProgress, type BatchProgress } from '../model/batch-progress.js'
import { rowBytesOnDevice } from '../model/row-view.js'
import { batchToastText } from '../model/batch-toast.js'
import { downloadToToastId, type DownloadTo } from './useDownloadTo.js'
import type { TreeSelection } from '../components/folder/FolderTree.js'
import type { SelectAllBox } from '../components/listing/ListControlsRow.js'
import type { SelectionBarSummary } from '../components/batch/SelectionBar.js'
import type { FileTreeNode, ShareFileRow } from '../types/types.js'
import type { Decoration } from '../types/ui.js'

const BROWSE_CTX = { isOwn: false, manualControls: true, ownerFileVerbs: false }
const NO_KEYS: readonly string[] = []

interface FolderBatchArgs {
  spaceId: string
  share: { id: string, owner: string }
  /** True on a browse folder, the only role that offers selection. */
  offered: boolean
  files: readonly ShareFileRow[]
  tree: { visibleTree: FileTreeNode[], isExpanded: (path: string) => boolean, deferredFilter: string }
  getDecoration: (relPath: string) => Decoration | null
  markSeeded: (relPaths: readonly string[]) => void
  downloadTo: DownloadTo
}

export interface FolderBatch {
  selection: TreeSelection | null
  selectAll: SelectAllBox | null
  selecting: boolean
  summary: SelectionBarSummary
  matchingCount: number
  /** No folder: the space's, as the strip's main half names it. */
  downloadSelected: (folder?: string) => void
  deselectHidden: () => void
  end: () => void
  progress: BatchProgress | null
  cancelAll: () => void
}

/** A batch none of whose files is under way any more is retired once its start window has passed. */
export function useRetireBatch(scopeKey: string, batch: DownloadBatch | null, progress: BatchProgress | null): void {
  useEffect(() => {
    if (batch && !progress?.batchLive && !batchIsRecent(batch)) clearDownloadBatch(scopeKey)
  }, [scopeKey, batch, progress])
}

/** Cancel All stops every download the strip counts, and forgets the batch. */
export function useCancelAll(scopeKey: string, progress: BatchProgress | null): () => void {
  const { cancelMany } = useTransferControls()
  return useCallback(() => {
    if (progress) cancelMany(progress.transferIds)
    clearDownloadBatch(scopeKey)
  }, [progress, cancelMany, scopeKey])
}

export function useFolderBatch({ spaceId, share, offered, files, tree, getDecoration, markSeeded, downloadTo }: FolderBatchArgs): FolderBatch {
  const { id: shareId, owner: ownerKey } = share
  const { visibleTree, isExpanded } = tree
  const filtering = tree.deferredFilter.trim().length > 0
  const { t } = useTranslation()
  const toast = useToast()
  const run = useRunAction()
  const scopeKey = batchScope(spaceId, shareId)

  const rowsByKey = useMemo(() => new Map(files.map((f) => [f.relPath, f])), [files])
  const verbsOf = useCallback((row: ShareFileRow) => batchVerbsFor(row, BROWSE_CTX), [])
  // The matching set and the per-folder keys come from one walk of the filtered tree: a row with
  // nothing a batch can do, and no copy on this device, has no box and is not in the set.
  const { shown, keys: matching, under } = useMemo(() => collectTreeKeys(visibleTree, (key) => {
    const row = rowsByKey.get(key)
    return row !== undefined && isBatchSelectable(verbsOf(row))
  }), [visibleTree, rowsByKey, verbsOf])
  const filesUnder = useCallback((path: string) => under.get(path) ?? NO_KEYS, [under])
  const order = useMemo(() => visibleOrder(visibleTree, isExpanded), [visibleTree, isExpanded])

  const sel = useBatchSelection({ scopeKey, order, filesUnder, matching })
  const { select, end } = sel
  const onBox = useCallback((id: string, shift: boolean) => { select(id, shift ? 'range' : 'toggle') }, [select])
  const selection = useMemo<TreeSelection | null>(
    () => (offered ? { mode: sel.mode, selected: sel.selected, selectable: matching, filesUnder, select, onBox } : null),
    [offered, sel.mode, sel.selected, matching, filesUnder, select, onBox],
  )
  useSelectionKeys({ enabled: offered && matching.size > 0, selecting: sel.mode, onSelectAll: sel.selectAll, onEnd: end })

  const full = useMemo(() => summarize({
    rows: files, keyOf: (f) => f.relPath, sizeOf: (f) => f.size, selected: sel.selected, shown, verbsOf,
  }), [files, sel.selected, shown, verbsOf])
  const summary: SelectionBarSummary = {
    count: full.count, bytes: full.bytes, hidden: full.hidden, onDevice: full.onDevice,
    download: full.download.length, unshare: 0,
  }

  const { current, movedText } = downloadTo
  const downloadSelected = useCallback((folder?: string) => run(async () => {
    const relPaths = full.download.map((f) => f.relPath)
    const destDir = folder ?? current?.path
    const res = await request('share:read-files', { spaceId, ownerKey, shareId, relPaths, destDir })
    if ('mirrored' in res) return
    if (res.started > 0) {
      startDownloadBatch(scopeKey, relPaths)
      markSeeded(relPaths)
    }
    const text = batchToastText({ results: [res], moved: destDir ? movedText(destDir) : null, t })
    if (text) toast.info(text, { id: downloadToToastId(spaceId) })
    end()
  }, 'transferFailed'), [run, full.download, current, movedText, spaceId, ownerKey, shareId, scopeKey, markSeeded, t, toast, end])

  const batch = useDownloadBatch(scopeKey)
  const recent = batch !== null && batchIsRecent(batch)
  // Only a browse folder downloads by hand: a mirror's own sync is not the user's to cancel here.
  const progress = useMemo(() => (offered ? deriveDownloadProgress({
    rows: files,
    keyOf: (row) => row.relPath,
    bytesOf: (row) => rowBytesOnDevice(row, getDecoration(row.relPath)),
    batchKeys: batch?.keys,
    recent,
  }) : null), [offered, files, getDecoration, batch, recent])
  useRetireBatch(scopeKey, batch, progress)
  const cancelAll = useCancelAll(scopeKey, progress)

  // No top box over nothing: a listing with no selectable file has no column to open.
  const selectAll = offered && matching.size > 0 ? {
    state: sel.topState,
    label: t(filtering ? 'batch.selectAllMatching' : 'batch.selectAll', { count: matching.size }),
    onToggle: sel.toggleTop,
  } : null

  return {
    selection,
    selectAll,
    selecting: offered && sel.mode,
    summary,
    matchingCount: matching.size,
    downloadSelected,
    deselectHidden: sel.deselectHidden,
    end,
    progress,
    cancelAll,
  }
}
