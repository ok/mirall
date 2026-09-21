import FolderPeopleCard from '../cards/FolderPeopleCard.js'
import FolderStatsCard from '../cards/FolderStatsCard.js'
import type { ComponentProps } from 'react'
import type { ShareWithRole } from '../../hooks/useShares.js'

type PeopleProps = ComponentProps<typeof FolderPeopleCard>
type StatsProps = ComponentProps<typeof FolderStatsCard>

interface FolderSidebarProps {
  spaceId: string
  share: ShareWithRole
  members: PeopleProps['members']
  owner: PeopleProps['owner']
  isYou: boolean
  profile: PeopleProps['selfProfile']
  /** Absent until the listing has answered — the stats tile has nothing to say without it. */
  info: { totalBytes: number, fileCount: number } | null | undefined
  onDeviceCount: StatsProps['onDevice']
  folderStatus: StatsProps['status']
}

/**
 * The read-only column beside a folder's listing: who is on the folder, and what it holds.
 *
 * Both tiles state; neither acts. `pr-4` is the same scrollbar gutter the list uses — without it
 * the tiles butt straight against their own scrollbar while the list sits 16px off its own.
 */
export default function FolderSidebar({ spaceId, share, members, owner, isYou, profile, info, onDeviceCount, folderStatus }: FolderSidebarProps) {
  return (
    <div className="space-y-6 min-h-0 overflow-y-auto scrollbar-thin pr-4 pb-1">
      <FolderPeopleCard
        spaceId={spaceId}
        shareId={share.id}
        members={members}
        owner={owner}
        isYou={isYou}
        selfProfile={profile}
        selfPublicKey={profile?.personKey ?? ''}
      />
      {info && (
        <FolderStatsCard
          folderName={share.name}
          totalBytes={info.totalBytes}
          fileCount={info.fileCount}
          onDevice={onDeviceCount}
          status={folderStatus}
        />
      )}
    </div>
  )
}
