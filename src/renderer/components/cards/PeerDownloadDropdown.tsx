import { useTranslation } from 'react-i18next'
import type { SpaceMember } from '../../types/types.js'
import { usePeerDownloadDetail } from '../../hooks/usePeerDownloadDetail.js'
import PeerDownloadRow from './PeerDownloadRow.js'

interface PeerDownloadDropdownProps {
  id: string
  spaceId: string
  path: string
  members: SpaceMember[]
}

// Rank by completion fraction; a peer whose total hasn't resolved yet sorts as 0
// rather than by raw byte count (which would rank it against fraction-ranked peers).
function fraction(p: { bytes: number; total: number }): number {
  return p.total > 0 ? p.bytes / p.total : 0
}

// Mounted only while the row is expanded, so its detail subscription (and the
// per-peer event stream) exists only while someone is looking. Shows at most five
// rows; the rest scroll.
export default function PeerDownloadDropdown({ id, spaceId, path, members }: PeerDownloadDropdownProps) {
  const { t } = useTranslation()
  const peers = usePeerDownloadDetail(spaceId, path)
  const rows = peers
    .map((p) => ({ ...p, member: members.find((m) => m.publicKey === p.personKey) ?? null }))
    .sort((a, b) => fraction(b) - fraction(a))

  if (rows.length === 0) return null
  // The region is named for what it lists: members waiting on our hash, downloaders, or both.
  const waitingCount = rows.filter((r) => r.waiting).length
  const listLabel = waitingCount === rows.length ? t('file.waitersList')
    : waitingCount === 0 ? t('file.downloadersList')
      : t('file.waitersAndDownloadersList')

  return (
    <div
      id={id}
      role="region"
      aria-label={listLabel}
      tabIndex={0}
      className="mt-1 ml-16 mr-3 mb-1 max-h-60 overflow-y-auto scrollbar-thin rounded-lg focus-ring"
    >
      <ul className="flex flex-col divide-y divide-progress-track">
        {rows.map((r) => (
          <PeerDownloadRow key={r.personKey} member={r.member} bytes={r.bytes} total={r.total} avgSpeed={r.avgSpeed} paused={r.paused} waiting={r.waiting} />
        ))}
      </ul>
    </div>
  )
}
