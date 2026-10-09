import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { SpaceMember, FileRecipient } from '../../types/types.js'
import { usePeerDownloadDetail } from '../../hooks/usePeerDownloadDetail.js'
import { recipientGroups } from '../../model/file-recipients.js'
import PeerDownloadRow from './PeerDownloadRow.js'
import RecipientRow from './RecipientRow.js'
import Icon from '../primitives/Icon.js'

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

type GroupKind = 'live' | 'have' | 'missing'

// A group is one wrapping line of pills behind a status icon: the check and the arrow are the ones the
// row already uses for "has it" and "downloading"; not yet is an empty ring. The gutter is the row's
// icon tile (w-12, then the row's gap-4), so the icon lines up with the file icon's right edge and the
// pills start under the file name. The group's name is the heading's sr-only text and the icon's tooltip.
function Group({ id, kind, label, children }: { id: string; kind: GroupKind; label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <h4 id={id} title={label} className="h-7 flex items-center justify-end">
        <span className="sr-only">{label}</span>
        {kind === 'have' && <Icon name="check_circle" size={16} className="text-on-success" />}
        {kind === 'live' && <Icon name="download" size={16} className="text-on-info" />}
        {kind === 'missing' && <span aria-hidden="true" className="w-3.5 h-3.5 rounded-full border-2 border-outline" />}
      </h4>
      <ul aria-labelledby={id} className="flex flex-wrap gap-1.5">{children}</ul>
    </div>
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
      <div id={id} role="region" aria-label={listLabel} tabIndex={0} className="mt-1 mx-5 mb-1 pl-16 max-h-60 overflow-y-auto scrollbar-thin rounded-lg focus-ring">
        <ul className="flex flex-wrap gap-1.5">{liveRows}</ul>
      </div>
    )
  }

  return (
    <div id={id} role="region" aria-label={t('file.recipientsList')} tabIndex={0} className="mt-1 mx-5 mb-1 max-h-80 overflow-y-auto scrollbar-thin rounded-lg focus-ring grid grid-cols-[3rem_1fr] gap-x-4 gap-y-2">
      {live.length > 0 && <Group id={`${id}-live`} kind="live" label={t('file.groupDownloading')}>{liveRows}</Group>}
      <Group id={`${id}-have`} kind="have" label={t('file.groupHaveIt')}>
        {haveIt.map((h) => <RecipientRow key={h.member.publicKey} member={h.member} receivedAt={h.ts} />)}
      </Group>
      {notYet.length > 0 && (
        <Group id={`${id}-missing`} kind="missing" label={t('file.groupNotYet')}>
          {notYet.map((m) => <RecipientRow key={m.member.publicKey} member={m.member} earlier={m.earlier} />)}
        </Group>
      )}
    </div>
  )
}
