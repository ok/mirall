import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import FolderTree from './FolderTree.js'
import FolderControlsRow from './FolderControlsRow.js'
import LoadingHeadline from '../primitives/LoadingHeadline.js'
import { useHasVerticalOverflow } from '../../hooks/useHasVerticalOverflow.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import type { ComponentProps } from 'react'
import type { FileTreeNode, ShareFileEntry, SpaceMember } from '../../types/types.js'

// The row callbacks and member list are FolderTree's contract, not this pane's: it forwards them
// untouched, so re-declaring them here would be a second copy to keep in step.
type TreeProps = ComponentProps<typeof FolderTree>

type FolderListPaneProps = Pick<TreeProps,
  'isOwn' | 'manualControls' | 'spaceId' | 'members' | 'getDownloadSummary' | 'getDecoration'
  | 'isSeeded' | 'onDownload' | 'onReveal' | 'onPause' | 'onCancel'
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
  files: readonly ShareFileEntry[]
  sourceMissing: boolean
  owner: SpaceMember | null | undefined
}

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
    ...tree
  } = props

  return (
    <div className="flex flex-col min-w-0 min-h-0">
      <FolderControlsRow
        value={filter}
        onChange={setFilter}
        matched={matched}
        total={filterableTotal}
        expandLabel={anyExpanded ? t('folder.collapseAll') : t('folder.expandAll')}
        onToggleExpand={toggleAll}
        showExpand={allFolderPaths.length > 0}
      />
      {/* Scroll-pane rules: see SpaceScreen's pane. `pt-1` is allowed here — no sticky header. */}
      <div
        ref={filesRef}
        className={`relative flex-1 overflow-y-auto scrollbar-thin min-h-0 -mx-1 -mt-1 pl-1 pt-1 pb-4${filesOverflow ? ' pr-4' : ' pr-1'}`}
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
