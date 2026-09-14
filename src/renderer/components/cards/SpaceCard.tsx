import { useTranslation } from 'react-i18next'
import type { Space } from '../../types.js'
import { gradientForSpaceId, formatDate } from '../../utils.js'
import { useSpaceMembers } from '../../hooks/useSpaceMembers.js'
import Icon, { type IconName } from '../primitives/Icon.js'
import AvatarStack from '../primitives/AvatarStack.js'

interface SpaceCardProps {
  space: Space
  onClick: () => void
}

export default function SpaceCard({ space, onClick }: SpaceCardProps) {
  const { t } = useTranslation()
  const gradient = gradientForSpaceId(space.spaceId)
  // spaces:list rosters are slim (no avatars); the facepile reads the cached full roster and
  // falls back to the slim entries (initials) until it lands.
  const roster = useSpaceMembers(space.spaceId)
  const facepile: { displayName: string; avatar?: string | null }[] =
    (roster.length ? roster : space.members ?? []).slice(0, 3)
  const memberCount = space.memberCount ?? (space.members?.length || 0)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      aria-label={space.status === 'pending'
        ? t('spaceCard.openSpacePending', { name: space.name })
        : t('spaceCard.openSpace', { name: space.name })}
      className="bg-surface-container-lowest hover:bg-surface-container-highest p-5 rounded-2xl flex items-center gap-6 transition-colors cursor-pointer focus-ring"
    >
      <div className={`w-16 h-16 rounded-xl ${gradient} flex items-center justify-center shrink-0`}>
        <Icon name={(space.icon as IconName) || 'hub'} size={32} className="text-on-primary" />
      </div>
      <div className="flex-grow min-w-0">
        <h3 className="text-xl font-headline font-bold text-accent truncate pb-0.5 mb-1">{space.name}</h3>
        <p className="text-on-surface-variant text-sm truncate">
          {t('spaces.memberCount', { count: memberCount })} • {t('spaces.createdLabel', { date: formatDate(space.created) })}
        </p>
      </div>
      {space.status === 'pending' && (
        <span className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-container-high text-on-surface-variant text-xs font-bold border border-outline">
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-on-surface-variant" />
          {t('spaces.waitingForApproval')}
        </span>
      )}
      {(space.pendingCount ?? 0) > 0 && (
        <span className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-secondary-container text-on-secondary-container text-xs font-bold">
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-on-secondary-container" />
          {t('spaces.waitingCount', { count: space.pendingCount })}
        </span>
      )}
      {memberCount > 0 && (
        <AvatarStack
          className="shrink-0"
          size="lg"
          surface="surface-container-lowest"
          announce="each"
          overflow={Math.max(0, memberCount - 3)}
          avatars={facepile.map((m, i) => ({
            key: String(i),
            src: m.avatar ?? null,
            displayName: m.displayName,
          }))}
        />
      )}
    </div>
  )
}
