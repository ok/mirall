import { useTranslation } from 'react-i18next'
import ShareCard from '../cards/ShareCard.js'
import SpaceSection from './SpaceSection.js'
import type { ComponentProps } from 'react'
import type { SpaceMember } from '../../types/types.js'
import type { ShareWithRole } from '../../hooks/useShares.js'

// The row callbacks are ShareCard's contract, not this section's.
type CardProps = ComponentProps<typeof ShareCard>

type SpaceSharesSectionProps = Pick<CardProps,
  'onOpen' | 'onOpenInFinder' | 'onDelete' | 'onLocate' | 'onMirror' | 'onUnmount'
  | 'onPauseMirror' | 'onResumeMirror' | 'selfProfile'
> & {
  shares: ShareWithRole[]
  members: SpaceMember[]
}

/**
 * The folder half of a space. Each card resolves its own owner from the roster, so a member who
 * has not loaded yet leaves the card ownerless rather than dropping the folder from the list.
 */
export default function SpaceSharesSection({ shares, members, ...card }: SpaceSharesSectionProps) {
  const { t } = useTranslation()
  if (shares.length === 0) return null
  return (
    <SpaceSection title={t('space.foldersShared')} count={t('space.folderCount', { count: shares.length })}>
      {shares.map((share) => (
        <ShareCard
          key={share.owner + ':' + share.id}
          share={share}
          owner={members.find((m) => m.publicKey === share.owner) ?? null}
          {...card}
        />
      ))}
    </SpaceSection>
  )
}
