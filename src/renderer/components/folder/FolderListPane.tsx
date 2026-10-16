import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import FolderTree from './FolderTree.js'
import ListControlsRow, { type SelectAllBox } from '../listing/ListControlsRow.js'
import LoadingHeadline from '../primitives/LoadingHeadline.js'
import { useHasVerticalOverflow } from '../../hooks/useHasVerticalOverflow.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import { useRowPointerSelect } from '../../hooks/useRowPointerSelect.js'
import type { ComponentProps, ReactNode } from 'react'
import type { FileTreeNode, ShareFileRow, SpaceMember } from '../../types/types.js'

// The row callbacks and member list are FolderTree's contract, not this pane's: it forwards them
// untouched, so re-declaring them here would be a second copy to keep in step.
type TreeProps = ComponentProps<typeof FolderTree>

type FolderListPaneProps = Pick<TreeProps,
  'isOwn' | 'manualControls' | 'spaceId' | 'members' | 'getDownloadSummary' | 'getRecipients' | 'ownerKey' | 'getDecoration'
  | 'isSeeded' | 'onDownload' | 'onReveal' | 'onPause' | 'onCancel' | 'selection'
> & {
  filter: string
  setFilter: (next: string) => void
  deferredFilter: string
  matched: number | null
  filterableTotal: number
  anyExpanded: boolean
  allFolderPaths: readonly string[]
  toggleAll: () => void
  visibleTree: FileTreeNode[]
  isExpanded: (path: string) => boolean
  toggle: (path: string) => void
  loading: boolean
  error: unknown
  files: readonly ShareFileRow[]
  sourceMissing: boolean
  owner: SpaceMember | null | undefined
  /** The top box, on a listing that offers selection. */
  selectAll: SelectAllBox | null
  /** The selection strip, rendered between the controls row and the list. */
  bar: ReactNode
}

/** The gutter the rows slide into while the column is open: the box's 40px plus the row gap. */
const PANE_AT_REST = 'pl-1'
const PANE_SELECTING = 'pl-14'

/**
 * The file half of a folder screen: the controls row and the scroll pane under it.
 *
 * Four terminal states share the pane — loading, unavailable, empty, filtered-to-nothing — and only
 * one of them is an error. They are branches rather than components because each is a single block
 * of copy whose only job is to say which of the four this is.
 */
export default function FolderListPane(props: FolderListPaneProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const { ref: filesRef, hasOverflow: filesOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const {
    filter, setFilter, deferredFilter, matched, filterableTotal, anyExpanded, allFolderPaths,
    toggleAll, visibleTree, isExpanded, toggle, loading, error, files, sourceMissing, owner,
    selectAll, bar, selection,
    ...tree
  } = props
  const selecting = selection?.mode === true
  useRowPointerSelect(filesRef, selection ? selection.select : null)

  return (
    <div className="flex flex-col min-w-0 min-h-0">
      <ListControlsRow
        value={filter}
        onChange={setFilter}
        matched={matched}
        total={filterableTotal}
        filterLabel={t('folder.filterLabel')}
        selectAll={selectAll}
        expandLabel={anyExpanded ? t('folder.collapseAll') : t('folder.expandAll')}
        onToggleExpand={toggleAll}
        showExpand={allFolderPaths.length > 0}
      />
      {bar}
      {/* Scroll-pane rules: see SpaceScreen's pane. `pt-1` is allowed here — no sticky header. The
          padding transition is the slide that opens the column; React keeps the node, so it plays
          both ways, and the global reduced-motion rule zeroes it. */}
      <div
        ref={filesRef}
        className={`relative flex-1 overflow-y-auto scrollbar-thin min-h-0 -mx-1 -mt-1 pt-1 pb-4 transition-[padding-left] duration-200 ease-[cubic-bezier(.2,0,0,1)] ${selecting ? PANE_SELECTING : PANE_AT_REST}${filesOverflow ? ' pr-4' : ' pr-1'}`}
      >
        {loading ? (
          <LoadingHeadline label={t('folder.loading')} />
        ) : error ? (
          <div role="alert" className="bg-surface-container-lowest rounded-xl p-12 flex flex-col items-center justify-center text-center">
            <div className="flex items-center gap-3 mb-3">
              <Icon name="warning" size={32} className="text-error" />
              <h2 className="text-2xl font-headline font-bold text-accent">{t('folder.unavailable')}</h2>
            </div>
            <p className="text-on-surface-variant max-w-md leading-relaxed">{errorText(error)}</p>
          </div>
        ) : files.length === 0 ? (
          <div className="bg-surface-container-lowest rounded-xl p-12 flex flex-col items-center justify-center text-center">
            <h2 className="text-2xl font-headline font-bold text-accent mb-3">
              {sourceMissing ? t('share.mountPointGone') : t('folder.empty')}
            </h2>
            <p className="text-on-surface-variant max-w-md leading-relaxed">
              {sourceMissing
                ? t('folder.emptyHintMissing')
                : tree.isOwn
                  ? t('folder.emptyHintMine')
                  : owner && owner.online === false
                    ? t('folder.emptyHintOfflineOwner', { owner: owner.displayName })
                    : t('folder.emptyHintOther', { owner: owner?.displayName ?? '?' })}
            </p>
          </div>
        ) : visibleTree.length === 0 ? (
          <div className="bg-surface-container-lowest rounded-xl p-12 flex flex-col items-center justify-center text-center">
            <h2 className="text-2xl font-headline font-bold text-accent mb-3">
              {t('folder.filterEmptyTitle', { term: deferredFilter.trim() })}
            </h2>
            <p className="text-on-surface-variant max-w-md leading-relaxed">
              {t('folder.filterEmptyHint', { count: filterableTotal })}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <FolderTree
              {...tree}
              selection={selection}
              nodes={visibleTree}
              isExpanded={isExpanded}
              onToggle={toggle}
            />
          </div>
        )}
      </div>
    </div>
  )
}
