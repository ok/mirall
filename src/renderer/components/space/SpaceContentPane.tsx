import DropZone from '../share-drop/DropZone.js'
import DropOverlay from '../share-drop/DropOverlay.js'
import SpaceMembersCard from '../cards/SpaceMembersCard.js'
import SpaceStorageCard from '../cards/SpaceStorageCard.js'
import SpaceEmptyState from './SpaceEmptyState.js'
import SpaceSharesSection from './SpaceSharesSection.js'
import SpaceFilesPane from './SpaceFilesPane.js'
import { useHasVerticalOverflow } from '../../hooks/useHasVerticalOverflow.js'
import { showSpaceEmptyState, showSpaceLoading } from '../../spaceContentState.js'
import type { ComponentProps } from 'react'
import type { SpaceMember } from '../../types.js'

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
  /** Both list sources in one shape; see spaceContentState.js for why emptiness needs both. */
  pane: Parameters<typeof showSpaceEmptyState>[0]
  shares: SharesProps['shares']
  selfProfile: SharesProps['selfProfile']
  onLocate: SharesProps['onLocate']
  cardActions: CardActions
  listing: Pick<FilesProps,
    'files' | 'error' | 'onRetry' | 'getDecoration' | 'isSeeded' | 'getDownloadSummary'
    | 'onDownload' | 'onCancel' | 'onPause' | 'onDiscardPartial'
  >
  drag: DropProps & { handlers: Record<string, unknown> }
  onFilesSelected: (files: File[]) => void
  onShareFolderRequest: (droppedPath: string) => void
}

/**
 * Everything on the space screen below the header and its banners: the scrolling content column
 * and the fixed sidebar beside it, inside the box that accepts a drop.
 *
 * Not rendered for a pending space — with no read key there is no content to lay out, and
 * PendingSpaceHero takes the whole area instead.
 */
export default function SpaceContentPane(props: SpaceContentPaneProps) {
  const { spaceId, members, isLegacy, pane, shares, cardActions: a, listing, drag } = props
  const { ref: filesRef, hasOverflow: filesOverflow } = useHasVerticalOverflow<HTMLDivElement>()

  return (
    <div
      /* No `overflow-hidden`: ShareCard's click target is an `absolute inset-0` overlay whose
         `focus-visible:ring-2` paints outside the card, and the cards sit flush against this box.
         `min-h-0` is what constrains the height; the drop overlay is inset from this same
         positioned ancestor, so its bounds are unchanged. */
      className="relative flex-1 min-h-0 grid grid-cols-1 min-[900px]:grid-cols-[1fr_300px] gap-8 pt-4 pb-8"
      {...(isLegacy ? {} : drag.handlers)}
    >
      <div
        ref={filesRef}
        /* SCROLL-PANE RULES (the one statement; FolderScreen and ActivityLog point here).
         `relative`: `sr-only` spans are `position: absolute` and clip only from their containing
         block, so an unpositioned pane lets rows below the fold grow the DOCUMENT into an OS
         scrollbar. `-mx-1 pl-1 pr-1`: 4px of ring room for a focused card, cancelled by the
         negative margin so nothing moves; `pr-4` is the shared scrollbar gutter. No `pt-*` under
         a `sticky top-0` header: it pins at the scrollport top PLUS the pane's padding-top. */
        className={`relative overflow-y-auto scrollbar-thin min-h-0 -mx-1 pl-1 pb-4 space-y-8${filesOverflow ? ' pr-4' : ' pr-1'}`}
      >
        {showSpaceEmptyState(pane) ? (
          <SpaceEmptyState />
        ) : (
          <>
            <SpaceSharesSection
              shares={shares}
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
            <SpaceFilesPane
              {...listing}
              members={members}
              loading={showSpaceLoading(pane)}
              onReveal={a.revealFile}
              onUnshare={a.removeFile}
              onCancelPublish={a.cancelPublish}
            />
          </>
        )}
      </div>

      <div className="flex flex-col gap-6 min-h-0 overflow-hidden pt-12">
        {!isLegacy && (
          <div className="shrink-0">
            <DropZone
              onFilesSelected={props.onFilesSelected}
              onFolderSelected={props.onShareFolderRequest}
              dragActive={drag.active}
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
