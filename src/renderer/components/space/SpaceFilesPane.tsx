import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import FileRow, { type LooseFileRowProps } from '../cards/FileRow.js'
import LoadingHeadline from '../primitives/LoadingHeadline.js'
import Callout from '../primitives/Callout.js'
import { fileName } from '../../format/utils.js'
import SpaceSection from './SpaceSection.js'
import type { FileEntry } from '../../types/types.js'
import type { PersonKey } from '../../../shared/contract/principals.js'
import { looseSelectKey, type LooseSelection } from '../../hooks/useSpaceBatch.js'

// The per-row callbacks and lookups are FileRow's contract, not this section's: forwarded
// untouched, so re-declaring them here would be a second copy to keep in step.
type SpaceFilesPaneProps = Pick<LooseFileRowProps,
  'onDownload' | 'downloadTo' | 'onCancel' | 'onPause' | 'onReveal' | 'onUnshare'
  | 'onCancelPublish' | 'members' | 'spaceId'
> & {
  files: FileEntry[]
  /** Our own person key; a row whose owner it is reads as ours. Null until the profile lands. */
  selfKey: PersonKey | null
  loading: boolean
  /** A reachable member's list has not been read in full yet, so more rows may arrive. */
  incomplete: boolean
  error: unknown
  onRetry: () => void
  getDecoration: (path: string) => LooseFileRowProps['decoration']
  isSeeded: (path: string) => boolean
  getDownloadSummary: (path: string) => LooseFileRowProps['downloadSummary']
  getRecipients: (path: string) => LooseFileRowProps['recipients']
  selection: LooseSelection
}

/**
 * The loose-file half of a space: still loading, unreadable, or a list, with a note above it while
 * a reachable member's files are still being read.
 *
 * The error branch is the only one with an action, because it is the only one the user can do
 * anything about — an empty list is not an error and renders nothing, since the screen's own
 * empty state already covers "nothing here at all".
 */
export default function SpaceFilesPane(props: SpaceFilesPaneProps) {
  const { t } = useTranslation()
  const { files, selfKey, loading, incomplete, error, onRetry, getDecoration, isSeeded, getDownloadSummary, getRecipients, selection, ...row } = props

  if (loading) return <LoadingHeadline label={t('space.loadingFiles')} />

  if (error && files.length === 0) {
    return (
      <div role="alert" className="bg-surface-container-lowest rounded-xl p-12 flex flex-col items-center justify-center text-center">
        <div className="flex items-center gap-3 mb-3">
          <Icon name="warning" size={32} className="text-error" />
          <h2 className="text-2xl font-headline font-bold text-accent">{t('space.filesError')}</h2>
        </div>
        <p className="text-on-surface-variant max-w-md leading-relaxed mb-6">{t('space.filesErrorHint')}</p>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-full bg-secondary-container px-6 py-2.5 font-label font-bold text-on-secondary-container hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Icon name="refresh" size={18} />
          {t('space.filesRetry')}
        </button>
      </div>
    )
  }

  const note = incomplete ? <Callout tone="note">{t('space.listIncomplete')}</Callout> : null
  if (files.length === 0) return note

  return (
    <SpaceSection title={t('space.filesShared')} count={t('space.fileCount', { count: files.length })}>
      {note}
      {files.map((file) => {
        const key = looseSelectKey(file)
        const selectable = selection.selectable.has(key)
        return (
          <FileRow
            kind="loose"
            key={`${file.owner.publicKey}-${file.path}`}
            file={file}
            isOwn={selfKey !== null && file.owner.publicKey === selfKey}
            decoration={getDecoration(file.path)}
            seeded={isSeeded(file.path)}
            downloadSummary={getDownloadSummary(file.path)}
            recipients={getRecipients(file.path)}
            selectKey={selectable ? key : undefined}
            selection={selection.mode && selectable
              ? { depth: 0, selected: selection.selected.has(key), label: t('space.selectNamed', { name: fileName(file.path) }) }
              : null}
            onSelect={selection.onBox}
            {...row}
          />
        )
      })}
    </SpaceSection>
  )
}
