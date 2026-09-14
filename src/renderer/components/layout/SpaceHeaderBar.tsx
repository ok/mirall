import { useTranslation } from 'react-i18next'
import Button from '../primitives/Button.js'
import ActionMenu from '../widgets/ActionMenu.js'
import EntityHeader from './EntityHeader.js'

interface SpaceHeaderActionsProps {
  isPending: boolean
  isLegacy: boolean
  favorite: boolean
  onCancelRequest: () => void
  onInvite: () => void
  onToggleFavorite: () => void
  onEdit: () => void
  onManageStorage: () => void
  onLeave: () => void
}

function SpaceHeaderActions({
  isPending,
  isLegacy,
  favorite,
  onCancelRequest,
  onInvite,
  onToggleFavorite,
  onEdit,
  onManageStorage,
  onLeave,
}: SpaceHeaderActionsProps) {
  const { t } = useTranslation()
  // Not a member yet — expose nothing member-only (invite/edit/storage), just a way to withdraw
  // the request.
  if (isPending) {
    return (
      <Button variant="secondary" icon="close" onClick={onCancelRequest}>
        {t('space.cancelRequest')}
      </Button>
    )
  }
  return (
    <>
      <Button icon="group_add" onClick={onInvite} disabled={isLegacy}>
        {t('space.inviteShort')}
      </Button>
      <ActionMenu
        label={t('space.more')}
        items={[
          {
            id: 'favorite',
            label: favorite ? t('space.removeFavorite') : t('space.addFavorite'),
            icon: 'star',
            iconFilled: favorite,
            onAction: onToggleFavorite,
          },
          {
            id: 'edit',
            label: t('space.edit'),
            icon: 'edit',
            disabled: isLegacy,
            onAction: onEdit,
          },
          {
            id: 'manage-storage',
            label: t('space.manageStorage'),
            icon: 'database',
            onAction: onManageStorage,
          },
          {
            id: 'leave',
            label: t('space.leave'),
            icon: 'logout',
            variant: 'danger',
            onAction: onLeave,
          },
        ]}
      />
    </>
  )
}

interface SpaceHeaderBarProps extends SpaceHeaderActionsProps {
  spaceName: string
  onBack: () => void
}

/**
 * The space screen's title row: the name, the legacy badge when one applies, and the acts.
 */
export default function SpaceHeaderBar({ spaceName, onBack, ...actions }: SpaceHeaderBarProps) {
  const { t } = useTranslation()
  return (
    <EntityHeader
      name={spaceName}
      onBack={onBack}
      titleAdornment={actions.isLegacy ? (
        <span className="shrink-0 inline-flex items-center px-2.5 py-1 rounded-full bg-error-container text-on-error-container text-xs font-bold border border-outline">
          {t('space.legacyBadge')}
        </span>
      ) : null}
      actions={<SpaceHeaderActions {...actions} />}
    />
  )
}
