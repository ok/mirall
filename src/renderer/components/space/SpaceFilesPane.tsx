import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import FileCard from '../cards/FileCard.js'
import LoadingHeadline from '../primitives/LoadingHeadline.js'
import SpaceSection from './SpaceSection.js'
import type { ComponentProps } from 'react'
import type { FileEntry } from '../../types.js'

// The per-row callbacks and lookups are FileCard's contract, not this section's: forwarded
// untouched, so re-declaring them here would be a second copy to keep in step.
type CardProps = ComponentProps<typeof FileCard>

type SpaceFilesPaneProps = Pick<CardProps,
  'onDownload' | 'onCancel' | 'onPause' | 'onReveal' | 'onUnshare' | 'onDiscardPartial'
  | 'onCancelPublish' | 'members'
> & {
  files: FileEntry[]
  loading: boolean
  error: unknown
  onRetry: () => void
  getDecoration: (path: string) => CardProps['decoration']
  isSeeded: (path: string) => boolean
  getDownloadSummary: (path: string) => CardProps['downloadSummary']
}

/**
 * The loose-file half of a space: still loading, unreadable, or a list.
 *
 * The error branch is the only one with an action, because it is the only one the user can do
 * anything about — an empty list is not an error and renders nothing, since the screen's own
 * empty state already covers "nothing here at all".
 */
export default function SpaceFilesPane(props: SpaceFilesPaneProps) {
  const { t } = useTranslation()
  const { files, loading, error, onRetry, getDecoration, isSeeded, getDownloadSummary, ...card } = props

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

  if (files.length === 0) return null

  return (
    <SpaceSection title={t('space.filesShared')} count={t('space.fileCount', { count: files.length })}>
      {files.map((file) => (
        <FileCard
          key={`${file.driveKey}-${file.path}`}
          file={file}
          decoration={getDecoration(file.path)}
          seeded={isSeeded(file.path)}
          downloadSummary={getDownloadSummary(file.path)}
          {...card}
        />
      ))}
    </SpaceSection>
  )
}
