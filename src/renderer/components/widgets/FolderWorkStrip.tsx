// One status strip above the folder's scroll pane. Every strip the screen can show renders through
// here, so the treatment can't drift between a paused mirror and a paused index — the only thing
// that varies is the sentence, the tone and which single verb (if any) it carries.
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import Button from '../primitives/Button.js'
import DownloadProgressLane from './DownloadProgressLane.js'
import { formatSize } from '../../utils.js'
import type { FolderStrip, StripAction, StripData, StripTone } from '../../folderStrips.js'

interface FolderWorkStripProps {
  strip: FolderStrip
  ownerName: string
  onAction: (action: 'locate' | 'resume' | 'pause') => void
}

const TONE: Record<StripTone, string> = {
  error: 'bg-error-container text-on-error-container',
  warning: 'bg-warning-container text-on-warning-container',
  info: 'bg-info/20 text-on-surface',
  neutral: 'bg-surface-container-low text-on-surface-variant',
}

const ICON_TONE: Record<StripTone, string> = {
  error: '',
  warning: '',
  info: 'text-on-info animate-pulse',
  neutral: '',
}

const ACTION_LABEL = {
  locate: 'share.locateFolder',
  resume: 'folder.indexResume',
  pause: 'folder.indexPause',
} as const

const ACTION_ICON = {
  locate: 'folder_open',
  resume: 'play_arrow',
  pause: 'pause',
} as const

const WORK_SENTENCE = {
  mirroring: 'folder.syncingSummaryPeer',
  'peer-indexing': 'folder.indexingSummaryPeer',
  indexing: 'folder.indexingSummary',
} as const

type Translate = (key: string, vars?: Record<string, string | number>) => string

// The queued size is a suffix rather than part of the sentence: only two of the three work states
// have one, and a peer's scan reports it as often as our own does.
function workSentence(t: Translate, data: StripData, ownerName: string): string {
  if (data.scanning) return t('folder.indexScanning')
  const kind = data.kind ?? 'indexing'
  const head = t(WORK_SENTENCE[kind], { count: data.files ?? 0, owner: ownerName })
  if (!data.bytes) return head
  const sizeKey = kind === 'mirroring' ? 'folder.syncingFetchSize' : 'folder.indexingQueuedSize'
  return head + ' · ' + t(sizeKey, { size: formatSize(data.bytes) })
}

function sentenceFor(t: Translate, strip: FolderStrip, ownerName: string): string {
  const data = strip.data
  switch (strip.id) {
    case 'source-missing':
      return t('folder.sourceMissingBanner')
    case 'owner-offline':
      return t('folder.offlineBanner', { owner: ownerName })
    case 'over-limit':
      return t('folder.overLimitListing', { shown: data?.shown ?? 0, total: data?.total ?? 0, limit: data?.limit ?? 0 })
    case 'paused':
      return data?.role === 'mirrored' ? t('folder.mirrorPausedBanner') : t('folder.indexPausedBanner')
    default:
      return workSentence(t, data ?? {}, ownerName)
  }
}

// The over-limit strip is the one whose live region has to PRE-EXIST (a role=status mounted
// already-populated is not reliably announced), so FolderView owns that wrapper and this renders
// the visual only — a second role here would announce it twice.
function liveRole(strip: FolderStrip): 'alert' | 'status' | undefined {
  if (strip.id === 'over-limit') return undefined
  if (strip.live === 'alert') return 'alert'
  if (strip.live === 'status') return 'status'
  return undefined
}

function StripActionButton({ action, onAction }: { action: StripAction; onAction: (action: 'locate' | 'resume' | 'pause') => void }) {
  const { t } = useTranslation()
  if (!action) return null
  return (
    <Button variant="secondary" icon={ACTION_ICON[action]} onClick={() => onAction(action)}>
      {t(ACTION_LABEL[action])}
    </Button>
  )
}

export default function FolderWorkStrip({ strip, ownerName, onAction }: FolderWorkStripProps) {
  const { t } = useTranslation()
  const data = strip.data
  const showLane = strip.id === 'working' && !data?.scanning
  const indeterminate = data?.indeterminate ?? true

  return (
    <div role={liveRole(strip)} className={`flex items-center gap-3 px-4 py-2 rounded-lg text-sm ${TONE[strip.tone]}`}>
      <Icon name={strip.icon} size={16} className={`shrink-0 ${ICON_TONE[strip.tone]}`} />
      {/* Only the working sentences truncate: they are short and re-render twice a second, so a
          reflow would be visible. The informational ones run to 130 characters and wrap, as they
          did before — an ellipsised "Source folder moved or unavailable…" hides the instruction. */}
      <span className={`flex-1 min-w-0${strip.id === 'working' || strip.id === 'peer-indexing' ? ' truncate' : ''}`}>
        {sentenceFor(t, strip, ownerName)}
      </span>
      {showLane && (
        <span className="basis-40 shrink-0">
          {/* No ETA token: this lane never resolves one. Indexing cannot have a percentage at all
              (the queue is still growing while the disk walk discovers files, so a denominator
              would move), and a mirror is indeterminate only when the listing is truncated — both
              are unmeasurable, not warming up, so "Estimating…" promised a number that never came.
              The sentence to the left already carries the verb and a live countdown. An
              indeterminate bar drops aria-valuenow per the ARIA contract, so the valuetext says
              what the missing number means. */}
          <DownloadProgressLane
            value={data?.pct ?? 0}
            label={t(data?.kind === 'mirroring' ? 'file.downloadProgress' : 'file.indexingProgress')}
            indeterminateText={t('format.progressUnknown')}
            indeterminate={indeterminate}
            showPct={!indeterminate}
          />
        </span>
      )}
      <StripActionButton action={strip.action} onAction={onAction} />
    </div>
  )
}
