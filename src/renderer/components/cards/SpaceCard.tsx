import { useTranslation } from 'react-i18next'
import type { Space } from '../../types.js'
import { gradientForSpaceId, formatDate } from '../../utils.js'
import { useSpaceMembers } from '../../hooks/useSpaceMembers.js'
import Icon, { type IconName } from '../primitives/Icon.js'
import Avatar from '../primitives/Avatar.js'

interface SpaceCardProps {
  space: Space
  onClick: () => void
  onToggleFavorite: (spaceId: string) => void
  onEdit: (space: Space) => void
}

export default function SpaceCard({ space, onClick, onToggleFavorite, onEdit }: SpaceCardProps) {
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
      className="group bg-surface-container-lowest hover:bg-surface-container-highest p-5 rounded-2xl flex items-center gap-6 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
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
        <div className="flex items-center -space-x-3 shrink-0">
          {facepile.map((m, i) => (
            <Avatar key={i} src={m.avatar ?? null} displayName={m.displayName} size="lg" ring="surface-container-lowest" />
          ))}
          {memberCount > 3 && (
            <div
              aria-hidden="true"
              style={{ boxShadow: '0 0 0 2px var(--color-surface-container-lowest)' }}
              className="w-12 h-12 rounded-full bg-surface-container-highest flex items-center justify-center text-sm font-bold text-on-surface-variant"
            >
              +{memberCount - 3}
            </div>
          )}
        </div>
      )}
      <div className="hidden flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onEdit(space) }}
          aria-label={t('space.edit')}
          className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-surface-container-high/50 active:scale-95 transition-all opacity-0 group-hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
        >
          <Icon name="edit" className="text-outline/40" />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleFavorite(space.spaceId) }}
          aria-label={t(space.favorite ? 'space.removeFavorite' : 'space.addFavorite')}
          aria-pressed={space.favorite}
          className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-surface-container-high/50 active:scale-95 transition-all opacity-0 group-hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 256 256"
            className="text-outline/40"
            fill="currentColor"
            aria-hidden="true"
          >
            <g transform="translate(1.4065934065934016 1.4065934065934016) scale(2.81 2.81)">
              {space.favorite ? (
                <path d="M 47.755 3.765 l 11.525 23.353 c 0.448 0.907 1.313 1.535 2.314 1.681 l 25.772 3.745 c 2.52 0.366 3.527 3.463 1.703 5.241 L 70.42 55.962 c -0.724 0.706 -1.055 1.723 -0.884 2.72 l 4.402 25.667 c 0.431 2.51 -2.204 4.424 -4.458 3.239 L 46.43 75.47 c -0.895 -0.471 -1.965 -0.471 -2.86 0 L 20.519 87.588 c -2.254 1.185 -4.889 -0.729 -4.458 -3.239 l 4.402 -25.667 c 0.171 -0.997 -0.16 -2.014 -0.884 -2.72 L 0.931 37.784 c -1.824 -1.778 -0.817 -4.875 1.703 -5.241 l 25.772 -3.745 c 1.001 -0.145 1.866 -0.774 2.314 -1.681 L 42.245 3.765 C 43.372 1.481 46.628 1.481 47.755 3.765 z" />
              ) : (
                <path stroke="currentColor" strokeWidth={3.5} strokeLinejoin="round" d="M 69.671 88.046 c -0.808 0 -1.62 -0.195 -2.37 -0.59 L 45 75.732 L 22.7 87.456 c -1.727 0.907 -3.779 0.757 -5.356 -0.388 c -1.577 -1.146 -2.352 -3.052 -2.023 -4.972 l 4.259 -24.832 L 1.539 39.678 c -1.396 -1.361 -1.889 -3.358 -1.287 -5.213 c 0.603 -1.854 2.176 -3.181 4.105 -3.461 l 24.932 -3.622 L 40.44 4.79 C 41.303 3.041 43.05 1.955 45 1.955 c 0 0 0 0 0.001 0 c 1.949 0 3.696 1.086 4.559 2.834 l 11.15 22.592 l 24.932 3.623 c 1.93 0.28 3.503 1.606 4.105 3.461 c 0.603 1.854 0.109 3.851 -1.287 5.213 L 70.419 57.264 l 4.26 24.832 c 0.329 1.921 -0.446 3.827 -2.023 4.972 C 71.764 87.717 70.721 88.046 69.671 88.046 z M 7.055 36.676 l 17.058 16.628 c 1.198 1.167 1.746 2.85 1.462 4.502 l -4.027 23.479 l 21.086 -11.086 c 1.481 -0.779 3.25 -0.779 4.732 0 l 21.085 11.086 l -4.027 -23.48 c -0.283 -1.649 0.264 -3.333 1.463 -4.501 l 17.058 -16.628 L 59.372 33.25 c -1.658 -0.242 -3.089 -1.282 -3.829 -2.783 L 45 9.106 L 34.457 30.468 c -0.74 1.5 -2.171 2.54 -3.827 2.782 L 7.055 36.676 z M 84.779 36.942 h 0.011 H 84.779 z M 44.18 7.444 c 0 0 0 0.001 0.001 0.002 L 44.18 7.444 C 44.18 7.445 44.18 7.445 44.18 7.444 z" />
              )}
            </g>
          </svg>
        </button>
      </div>
    </div>
  )
}
