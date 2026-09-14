import { useTranslation } from 'react-i18next'
import type { ActionMenuItemConfig } from '../components/widgets/ActionMenu.js'

type FolderMenuInput = {
  isYou: boolean
  paused: boolean
  /** Our own scan is running: see below for why only ours gates anything. */
  busy: boolean
  setPaused: (next: boolean) => void
  unmount: () => void
  onDelete: () => void
  onEdit: () => void
}

/**
 * The More menu on a folder header: one Pause/Resume verb, Edit, and the role's destructive entry.
 *
 * Only the destructive entry is ever disabled, and only while OUR OWN scan runs — Pause lives in
 * this same menu and is the one control you reach for while a folder is working, so gating the
 * trigger would put it out of reach.
 */
export function useFolderMenu({ isYou, paused, busy, setPaused, unmount, onDelete, onEdit }: FolderMenuInput): ActionMenuItemConfig[] {
  const { t } = useTranslation()
  const destructive: ActionMenuItemConfig = {
    ...(isYou
      ? { id: 'delete', label: t('share.deleteFolder'), icon: 'delete', onAction: onDelete }
      : { id: 'unmount', label: t('share.unmountMirror'), icon: 'close', onAction: unmount }),
    variant: 'danger',
    disabled: busy,
    hint: busy ? t('share.notWhileSyncing') : undefined,
  }
  return [
    paused
      ? { id: 'resume', label: t('share.resumeSyncing'), icon: 'play_arrow', onAction: () => setPaused(false) }
      : { id: 'pause', label: t('share.pauseSyncing'), icon: 'pause', onAction: () => setPaused(true) },
    { id: 'edit', label: t('share.editFolder'), icon: 'edit', onAction: onEdit },
    destructive,
  ]
}
