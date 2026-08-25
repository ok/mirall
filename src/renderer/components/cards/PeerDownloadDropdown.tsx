import { useTranslation } from 'react-i18next'
import type { SpaceMember } from '../../types.js'
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
    .map((p) => ({ ...p, member: members.find((m) => m.publicKey === p.peerKey) ?? null }))
    .sort((a, b) => fraction(b) - fraction(a))

  if (rows.length === 0) return null

  return (
    <div
      id={id}
      role="region"
      aria-label={t('file.downloadersList')}
      tabIndex={0}
      className="mt-1 ml-16 mr-3 mb-1 max-h-60 overflow-y-auto scrollbar-thin rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
    >
      <ul className="flex flex-col divide-y divide-progress-track">
        {rows.map((r) => (
          <PeerDownloadRow key={r.peerKey} member={r.member} bytes={r.bytes} total={r.total} avgSpeed={r.avgSpeed} paused={r.paused} />
        ))}
      </ul>
    </div>
  )
}
