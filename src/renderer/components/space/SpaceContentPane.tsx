import { useTranslation } from 'react-i18next'
import DropZone from '../share-drop/DropZone.js'
import DropOverlay from '../share-drop/DropOverlay.js'
import SpaceMembersCard from '../cards/SpaceMembersCard.js'
import SpaceStorageCard from '../cards/SpaceStorageCard.js'
import SpaceEmptyState from './SpaceEmptyState.js'
import SpaceSharesSection from './SpaceSharesSection.js'
import SpaceFilesPane from './SpaceFilesPane.js'
import ListControlsRow from '../listing/ListControlsRow.js'
import SelectionBar from '../batch/SelectionBar.js'
import BatchProgressStrip from '../batch/BatchProgressStrip.js'
import BatchAnnouncement from '../batch/BatchAnnouncement.js'
import { useFileRecipients } from '../../hooks/useFileRecipients.js'
import { useHasVerticalOverflow } from '../../hooks/useHasVerticalOverflow.js'
import { useRowPointerSelect } from '../../hooks/useRowPointerSelect.js'
import { showFilesIncomplete, showSpaceEmptyState, showSpaceLoading } from '../../model/space-content-state.js'
import type { ComponentProps } from 'react'
import type { SpaceMember } from '../../types/types.js'
import type { SpaceBatch } from '../../hooks/useSpaceBatch.js'

type SharesProps = ComponentProps<typeof SpaceSharesSection>
type FilesProps = ComponentProps<typeof SpaceFilesPane>
type DropProps = ComponentProps<typeof DropOverlay>

// The card handlers arrive as one object because they are memoized together and every one of them
// is forwarded untouched; naming them twice here would be a second copy of useSpaceCardActions'
// contract. Same for the file listing, which is useFiles' return plus its two lookups.
type CardActions = {
  openShare: SharesProps['onOpen']
  openInFinder: SharesProps['onOpenInFinder']
  deleteShare: SharesProps['onDelete']
  mirrorShare: SharesProps['onMirror']
  unmount: SharesProps['onUnmount']
  pauseMirror: SharesProps['onPauseMirror']
  resumeMirror: SharesProps['onResumeMirror']
  revealFile: FilesProps['onReveal']
  removeFile: FilesProps['onUnshare']
  cancelPublish: FilesProps['onCancelPublish']
}

interface SpaceContentPaneProps {
  spaceId: string
  members: SpaceMember[]
  /** A space from before v1.7.0: it can be read and left, but nothing can be added to it. */
  isLegacy: boolean
  // A held catalog (a restore being confirmed) cannot take new files yet.
  shareHeld: boolean
  /** Both list sources in one shape; see spaceContentState.js for why emptiness needs both. */
  pane: Parameters<typeof showSpaceEmptyState>[0]
  /** The filter and the batch selection over the loose files; its lists are the filtered ones. */
  batch: SpaceBatch
  selfProfile: SharesProps['selfProfile']
  onLocate: SharesProps['onLocate']
  cardActions: CardActions
  listing: Pick<FilesProps,
    'error' | 'onRetry' | 'getDecoration' | 'isSeeded' | 'getDownloadSummary'
    | 'onDownload' | 'onCancel' | 'onPause'
  >
  drag: DropProps & { handlers: Record<string, unknown> }
  onFilesSelected: (files: File[]) => void
  onShareFolderRequest: (droppedPath: string) => void
  onUnshareSelected: () => void
}

/**
 * Everything on the space screen below the header and its banners: the scrolling content column
 * and the fixed sidebar beside it, inside the box that accepts a drop.
 *
 * Not rendered for a pending space — with no read key there is no content to lay out, and
 * PendingSpaceHero takes the whole area instead.
 */
export default function SpaceContentPane(props: SpaceContentPaneProps) {
  const { t } = useTranslation()
  const { spaceId, members, isLegacy, pane, batch, cardActions: a, listing, drag } = props
  const getRecipients = useFileRecipients(spaceId)
  const { ref: filesRef, hasOverflow: filesOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  useRowPointerSelect(filesRef, batch.selection.select)
  const filtering = batch.filter.trim().length > 0
  const nothingMatches = filtering && batch.files.length === 0 && (batch.selecting || batch.shares.length === 0)

  return (
    <div
      /* No `overflow-hidden`: ShareCard's click target is an `absolute inset-0` overlay whose
         `focus-visible:ring-2` paints outside the card, and the cards sit flush against this box.
         `min-h-0` is what constrains the height; the drop overlay is inset from this same
         positioned ancestor, so its bounds are unchanged. */
      className="relative flex-1 min-h-0 grid grid-cols-[1fr_300px] gap-8 pt-4 pb-8"
      {...(isLegacy || props.shareHeld ? {} : drag.handlers)}
    >
      <div className="flex flex-col min-w-0 min-h-0">
        {/* The controls row exists once there is a list to control: not over the loading headline,
            and not over the empty state. */}
        {!showSpaceLoading(pane) && !showSpaceEmptyState(pane) && (
          <ListControlsRow
            value={batch.filter}
            onChange={batch.setFilter}
            matched={batch.matched}
            total={batch.total}
            filterLabel={t('space.filterLabel')}
            selectAll={batch.selectAll}
            showExpand={false}
          />
        )}
        {/* The pinned slot above the list: a running batch's strip, then the selection's own. */}
        {batch.progress && (
          <div className="shrink-0 pb-3">
            <BatchProgressStrip progress={batch.progress} onCancelAll={batch.cancelAll} />
          </div>
        )}
        <BatchAnnouncement live={batch.progress !== null} />
        <SelectionBar
          selecting={batch.selecting}
          summary={batch.summary}
          matchingCount={batch.matchingCount}
          onDownload={batch.downloadSelected}
          onCancel={batch.cancelSelected}
          onUnshare={props.onUnshareSelected}
          onDeselectHidden={batch.deselectHidden}
          onDone={batch.end}
        />
        <div
          ref={filesRef}
          /* SCROLL-PANE RULES (the one statement; FolderScreen and ActivityLog point here).
           `relative`: `sr-only` spans are `position: absolute` and clip only from their containing
           block, so an unpositioned pane lets rows below the fold grow the DOCUMENT into an OS
           scrollbar. `-mx-1 pl-1 pr-1`: 4px of ring room for a focused card, cancelled by the
           negative margin so nothing moves; `pr-4` is the shared scrollbar gutter. No `pt-*` under
           a `sticky top-0` header: it pins at the scrollport top PLUS the pane's padding-top. The
           gutter the rows slide into while selecting is horizontal padding only, for that reason. */
          className={`relative overflow-y-auto scrollbar-thin min-h-0 -mx-1 pb-4 space-y-8 transition-[padding-left] duration-200 ease-[cubic-bezier(.2,0,0,1)] ${batch.selecting ? 'pl-14' : 'pl-1'}${filesOverflow ? ' pr-4' : ' pr-1'}`}
        >
          {showSpaceEmptyState(pane) ? (
            <SpaceEmptyState />
          ) : nothingMatches ? (
            <div className="bg-surface-container-lowest rounded-xl p-12 flex flex-col items-center justify-center text-center">
              <h2 className="text-2xl font-headline font-bold text-accent mb-3">
                {t('folder.filterEmptyTitle', { term: batch.filter.trim() })}
              </h2>
              <p className="text-on-surface-variant max-w-md leading-relaxed">
                {t('space.filterEmptyHint', { count: batch.total })}
              </p>
            </div>
          ) : (
            <>
              {/* Folder cards take no part in a batch, and opening one would leave the screen
                  mid-selection, so they leave the list while the column is open. */}
              {!batch.selecting && (
                <SpaceSharesSection
                  shares={batch.shares}
                  members={members}
                  selfProfile={props.selfProfile}
                  onLocate={props.onLocate}
                  onOpen={a.openShare}
                  onOpenInFinder={a.openInFinder}
                  onDelete={a.deleteShare}
                  onMirror={a.mirrorShare}
                  onUnmount={a.unmount}
                  onPauseMirror={a.pauseMirror}
                  onResumeMirror={a.resumeMirror}
                />
              )}
              <SpaceFilesPane
                {...listing}
                files={batch.files}
                selection={batch.selection}
                getRecipients={getRecipients}
                selfKey={props.selfProfile?.personKey ?? null}
                spaceId={spaceId}
                members={members}
                loading={showSpaceLoading(pane)}
                incomplete={showFilesIncomplete(pane)}
                onReveal={a.revealFile}
                onUnshare={a.removeFile}
                onCancelPublish={a.cancelPublish}
              />
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-6 min-h-0 overflow-hidden">
        {!isLegacy && (
          <div className="shrink-0">
            <DropZone
              onFilesSelected={props.onFilesSelected}
              onFolderSelected={props.onShareFolderRequest}
              dragActive={drag.active}
              shareHeld={props.shareHeld}
            />
          </div>
        )}
        {/* People above size, the same order the folder screen's sidebar uses. Members is the
          one that folds and the one that grows, so it takes the flexible slot; Storage is a
          fixed three-line statement and sits under it. */}
        <SpaceMembersCard spaceId={spaceId} members={members} />
        <div className="shrink-0">
          <SpaceStorageCard spaceId={spaceId} />
        </div>
      </div>

      <DropOverlay active={drag.active} kind={drag.kind} fileCount={drag.fileCount} folderName={drag.folderName} />
    </div>
  )
}
