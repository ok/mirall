import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { SpaceMember, FileRecipient } from '../../types/types.js'
import { usePeerDownloadDetail } from '../../hooks/usePeerDownloadDetail.js'
import { recipientGroups } from '../../model/file-recipients.js'
import PeerDownloadRow from './PeerDownloadRow.js'
import RecipientRow from './RecipientRow.js'

interface PeerDownloadDropdownProps {
  id: string
  spaceId: string
  path: string
  members: SpaceMember[]
  recipients: FileRecipient[]
  contentHash: string
  ownerKey: string
}

// Rank by completion fraction; a peer whose total hasn't resolved yet sorts as 0
// rather than by raw byte count (which would rank it against fraction-ranked peers).
function fraction(p: { bytes: number; total: number }): number {
  return p.total > 0 ? p.bytes / p.total : 0
}

// The sticky heading's fill tracks the row's own, so it hides what scrolls under it in either state.
function Group({ id, label, count, children }: { id: string; label: string; count: number; children: ReactNode }) {
  return (
    <>
      <h4 id={id} className="sticky top-0 z-10 px-1 pt-3 pb-1.5 text-xs font-bold uppercase tracking-wide text-secondary bg-surface-container-lowest dark:bg-surface-container-low group-hover:bg-surface-container-highest dark:group-hover:bg-surface-container-highest transition-colors">
        {label} <span className="text-on-surface-variant font-semibold">{count}</span>
      </h4>
      <ul aria-labelledby={id} className="flex flex-col divide-y divide-progress-track">{children}</ul>
    </>
  )
}

// Mounted only while the row is expanded, so its detail subscription (and the per-peer event stream)
// exists only while someone is looking. Until a member holds the current version it lists the live
// downloads alone; from then on it lists everyone, grouped by what the owner can do about each.
export default function PeerDownloadDropdown({ id, spaceId, path, members, recipients, contentHash, ownerKey }: PeerDownloadDropdownProps) {
  const { t } = useTranslation()
  const peers = usePeerDownloadDetail(spaceId, path)
  const live = peers
    .map((p) => ({ ...p, member: members.find((m) => m.publicKey === p.personKey) ?? null }))
    .sort((a, b) => fraction(b) - fraction(a))
  const { haveIt, notYet } = recipientGroups({ recipients, contentHash, members, ownerKey, active: new Set(live.map((p) => p.personKey)) })
  const liveRows = live.map((r) => (
    <PeerDownloadRow key={r.personKey} member={r.member} bytes={r.bytes} total={r.total} avgSpeed={r.avgSpeed} paused={r.paused} waiting={r.waiting} />
  ))

  if (haveIt.length === 0) {
    if (live.length === 0) return null
    // The region is named for what it lists: members waiting on our hash, downloaders, or both.
    const waitingCount = live.filter((r) => r.waiting).length
    const listLabel = waitingCount === live.length ? t('file.waitersList')
      : waitingCount === 0 ? t('file.downloadersList')
        : t('file.waitersAndDownloadersList')
    return (
      <div id={id} role="region" aria-label={listLabel} tabIndex={0} className="mt-1 ml-16 mr-3 mb-1 max-h-60 overflow-y-auto scrollbar-thin rounded-lg focus-ring">
        <ul className="flex flex-col divide-y divide-progress-track">{liveRows}</ul>
      </div>
    )
  }

  return (
    <div id={id} role="region" aria-label={t('file.recipientsList')} tabIndex={0} className="relative mt-1 ml-16 mr-3 mb-1 max-h-80 overflow-y-auto scrollbar-thin rounded-lg focus-ring">
      {live.length > 0 && <Group id={`${id}-live`} label={t('file.groupDownloading')} count={live.length}>{liveRows}</Group>}
      <Group id={`${id}-have`} label={t('file.groupHaveIt')} count={haveIt.length}>
        {haveIt.map((h) => <RecipientRow key={h.member.publicKey} member={h.member} receivedAt={h.ts} />)}
      </Group>
      {notYet.length > 0 && (
        <Group id={`${id}-missing`} label={t('file.groupNotYet')} count={notYet.length}>
          {notYet.map((m) => <RecipientRow key={m.member.publicKey} member={m.member} earlier={m.earlier} />)}
        </Group>
      )}
    </div>
  )
}
