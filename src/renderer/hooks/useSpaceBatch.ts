// The space screen's filter and its batch selection over loose files. A selection mixes own files
// and others', so the strip offers one verb per bucket; a Download groups the picked files by
// owner and sends one batch per owner. Folder cards take no part: they are hidden while the column
// is open. The filter term and the selection are screen-local and reset when the space changes
// without a remount.
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc/ipc.js'
import { useToast } from '../components/toast/ToastProvider.js'
import { useRunAction } from './useRunAction.js'
import { useBatchSelection } from './useBatchSelection.js'
import { useSelectionKeys } from './useSelectionKeys.js'
import { useTransferControls } from './useTransferControls.js'
import { batchIsRecent, batchScope, clearDownloadBatch, startDownloadBatch, useDownloadBatch } from './useDownloadBatch.js'
import { skippedToast, useRetireBatch } from './useFolderBatch.js'
import { summarize, type Gesture } from '../model/batch-selection.js'
import { batchVerbsFor, isBatchSelectable } from '../model/file-row-action.js'
import { deriveBatchProgress, type BatchProgress } from '../model/batch-progress.js'
import { filterSpace } from '../model/space-filter.js'
import { rowBytesOnDevice } from '../model/row-view.js'
import type { ShareWithRole } from './useShares.js'
import type { SelectAllBox } from '../components/listing/ListControlsRow.js'
import type { SelectionBarSummary } from '../components/batch/SelectionBar.js'
import type { PersonKey } from '../../shared/contract/principals.js'
import type { FileEntry } from '../types/types.js'
import type { Decoration } from '../types/ui.js'

const NO_KEYS: readonly string[] = []

/** The selection key of a loose row: the owner separates two members' same-named files. */
export const looseSelectKey = (file: FileEntry): string => file.owner.publicKey + ':' + file.path

interface SpaceBatchArgs {
  spaceId: string
  files: readonly FileEntry[]
  shares: readonly ShareWithRole[]
  selfKey: PersonKey | null
  getDecoration: (path: string) => Decoration | null
  markSeeded: (paths: readonly string[]) => void
}

/** What a loose row needs to draw its box. */
export interface LooseSelection {
  mode: boolean
  selected: ReadonlySet<string>
  selectable: ReadonlySet<string>
  select: (key: string, gesture: Gesture) => boolean
  onBox: (key: string, shift: boolean) => void
}

export interface SpaceBatch {
  filter: string
  setFilter: (next: string) => void
  files: FileEntry[]
  shares: ShareWithRole[]
  matched: number | null
  total: number
  selection: LooseSelection
  selectAll: SelectAllBox | null
  selecting: boolean
  summary: SelectionBarSummary
  matchingCount: number
  unshareable: FileEntry[]
  downloadSelected: () => void
  cancelSelected: () => void
  deselectHidden: () => void
  end: () => void
  progress: BatchProgress | null
  cancelAll: () => void
}

export function useSpaceBatch({ spaceId, files, shares, selfKey, getDecoration, markSeeded }: SpaceBatchArgs): SpaceBatch {
  const { t } = useTranslation()
  const toast = useToast()
  const run = useRunAction()
  const { cancelMany } = useTransferControls()
  const scopeKey = batchScope(spaceId, null)

  const [filter, setFilter] = useState('')
  const [prevSpace, setPrevSpace] = useState(spaceId)
  if (prevSpace !== spaceId) { setPrevSpace(spaceId); setFilter('') }
  const view = useMemo(() => filterSpace({ files, shares }, filter), [files, shares, filter])

  const verbsOf = useCallback(
    (row: FileEntry) => batchVerbsFor(row, { isOwn: selfKey !== null && row.owner.publicKey === selfKey, manualControls: true, ownerFileVerbs: true }),
    [selfKey],
  )
  const rowsByKey = useMemo(() => new Map(files.map((f) => [looseSelectKey(f), f])), [files])
  // Selectable rows in the rendered order; a row with no batch verb and no copy here has no box.
  const selectableAll = useMemo(() => new Set(files.filter((f) => isBatchSelectable(verbsOf(f))).map(looseSelectKey)), [files, verbsOf])
  const shown = useMemo(() => new Set(view.files.map(looseSelectKey)), [view.files])
  const matching = useMemo(() => new Set([...shown].filter((k) => selectableAll.has(k))), [shown, selectableAll])
  const order = useMemo(() => [...matching], [matching])
  const filesUnder = useCallback(() => NO_KEYS, [])

  const sel = useBatchSelection({ scopeKey, order, filesUnder, matching })
  const { select, end } = sel
  const onBox = useCallback((key: string, shift: boolean) => { select(key, shift ? 'range' : 'toggle') }, [select])
  const selection = useMemo<LooseSelection>(
    () => ({ mode: sel.mode, selected: sel.selected, selectable: selectableAll, select, onBox }),
    [sel.mode, sel.selected, selectableAll, select, onBox],
  )
  useSelectionKeys({ enabled: matching.size > 0, selecting: sel.mode, onSelectAll: sel.selectAll, onEnd: end })

  const full = useMemo(() => summarize({
    rows: files, keyOf: looseSelectKey, sizeOf: (f) => f.size, selected: sel.selected, shown, verbsOf,
  }), [files, sel.selected, shown, verbsOf])
  const summary: SelectionBarSummary = {
    count: full.count, bytes: full.bytes, hidden: full.hidden, onDevice: full.onDevice,
    download: full.download.length, cancel: full.cancel.length, unshare: full.unshare.length,
  }

  // One request per owner, one after the other: a loose transfer is named by its path alone, so
  // two owners' same-named files share one transfer identity, and a second request sent while the
  // first runs would attach to it instead of starting its own. The strip and the seeds cover only
  // the owners whose batch started something.
  const downloadSelected = useCallback(() => run(async () => {
    const byOwner = new Map<string, FileEntry[]>()
    for (const f of full.download) byOwner.set(f.owner.publicKey, [...(byOwner.get(f.owner.publicKey) ?? []), f])
    const started: FileEntry[] = []
    const skipped: string[] = []
    let failure: Error | null = null
    for (const [ownerKey, owned] of byOwner) {
      try {
        const res = await request('files:download-many', { spaceId, ownerKey, paths: owned.map((f) => f.path) })
        if ('mirrored' in res) continue
        if (res.started > 0) started.push(...owned)
        const note = skippedToast(res, t)
        if (note) skipped.push(note)
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err))
      }
    }
    if (started.length > 0) {
      startDownloadBatch(scopeKey, started.map(looseSelectKey))
      markSeeded(started.map((f) => f.path))
    }
    end()
    if (skipped.length) toast.info(skipped.join(' · '))
    if (failure) throw failure
  }, 'transferFailed'), [run, full.download, spaceId, scopeKey, markSeeded, end, t, toast])

  const cancelSelected = useCallback(() => {
    cancelMany(full.cancel.flatMap((f) => (f.transferId ? [f.transferId] : [])))
    end()
  }, [cancelMany, full.cancel, end])

  const batch = useDownloadBatch(scopeKey)
  const recent = batch !== null && batchIsRecent(batch)
  const progress = useMemo(
    () => (batch ? deriveBatchProgress(batch.keys, rowsByKey, (row) => rowBytesOnDevice(row, getDecoration(row.path)), { recent }) : null),
    [batch, rowsByKey, getDecoration, recent],
  )
  useRetireBatch(scopeKey, batch, progress)
  const cancelAll = useCallback(() => {
    if (!batch) return
    const ids = batch.keys.flatMap((key) => { const row = rowsByKey.get(key); return row?.transferId ? [row.transferId] : [] })
    cancelMany(ids)
    clearDownloadBatch(scopeKey)
  }, [batch, rowsByKey, cancelMany, scopeKey])

  return {
    filter,
    setFilter,
    files: view.files,
    shares: view.shares,
    matched: view.matched,
    total: view.total,
    selection,
    selectAll: matching.size > 0 ? {
      state: sel.topState,
      label: t(filter.trim() ? 'batch.selectAllMatching' : 'batch.selectAll', { count: matching.size }),
      onToggle: sel.toggleTop,
    } : null,
    selecting: sel.mode,
    summary,
    matchingCount: matching.size,
    unshareable: full.unshare,
    downloadSelected,
    cancelSelected,
    deselectHidden: sel.deselectHidden,
    end,
    progress,
    cancelAll,
  }
}
