// A folder-share row on the space screen: the whole card opens the folder, and the
// action menu adapts to the share's role (owned, mirrored to disk, or browse-only).
import { useTranslation } from 'react-i18next'
import type { ShareWithRole } from '../../hooks/useShares.js'
import type { Profile, SpaceMember } from '../../types.js'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import ActionMenu, { type ActionMenuItemConfig } from '../widgets/ActionMenu.js'
import Badge from '../primitives/Badge.js'
import Avatar from '../primitives/Avatar.js'
import { roleBadge } from '../../statusBadge.js'
import { shareSizeLine } from '../../shareSizeLine.js'
import { formatSize } from '../../utils.js'

interface ShareCardProps {
  share: ShareWithRole
  owner: SpaceMember | null
  selfProfile: Profile | null
  fileCount?: number
  totalBytes?: number
  onOpen: (share: ShareWithRole) => void
  onDelete?: (share: ShareWithRole) => void
  onMirror?: (share: ShareWithRole) => void
  onUnmount?: (share: ShareWithRole) => void
  onPauseMirror?: (share: ShareWithRole) => void
  onResumeMirror?: (share: ShareWithRole) => void
  onChangeMirrorLocation?: (share: ShareWithRole) => void
  onOpenInFinder?: (share: ShareWithRole) => void
  onLocate?: (share: ShareWithRole) => void
}

function resolveOwnerView(owner: SpaceMember | null, isYou: boolean, selfProfile: Profile | null) {
  if (isYou && selfProfile) {
    return { avatar: selfProfile.avatar, displayName: selfProfile.displayName }
  }
  if (owner) return { avatar: owner.avatar ?? null, displayName: owner.displayName }
  return { avatar: null, displayName: null }
}

function OwnerAvatar({ owner, isYou, selfProfile }: { owner: SpaceMember | null; isYou: boolean; selfProfile: Profile | null }) {
  const resolved = resolveOwnerView(owner, isYou, selfProfile)
  return (
    <Avatar
      src={resolved.avatar}
      displayName={resolved.displayName}
      size="xs"
      ring="surface-container-lowest"
    />
  )
}

export default function ShareCard({
  share,
  owner,
  selfProfile,
  fileCount,
  totalBytes,
  onOpen,
  onDelete,
  onMirror,
  onUnmount,
  onPauseMirror,
  onResumeMirror,
  onChangeMirrorLocation,
  onOpenInFinder,
  onLocate,
}: ShareCardProps) {
  const { t } = useTranslation()
  const isYou = share.role === 'mine'
  const sourceMissing = isYou && share.mountStatus === 'mount-point-gone'
  const mirrorPaused = share.role === 'mirrored' && share.mirrorEnabled === false
  const badge = roleBadge(share.role, { paused: mirrorPaused, missing: sourceMissing })

  const sizeLine = shareSizeLine({
    isYou,
    ownerName: owner?.displayName,
    fileCount,
    size: totalBytes != null ? formatSize(totalBytes) : '—',
  }, t)

  const menuItems: ActionMenuItemConfig[] = (() => {
    const items: ActionMenuItemConfig[] = []
    if (share.role === 'mine') {
      if (sourceMissing && onLocate) items.push({ id: 'locate', label: t('share.locateFolder'), icon: 'folder_open', onAction: () => onLocate(share) })
      if (!sourceMissing && onOpenInFinder) items.push({ id: 'open-finder', label: t('share.openInFinder'), icon: 'folder_open', onAction: () => onOpenInFinder(share) })
      if (onDelete) items.push({ id: 'delete', label: t('share.deleteFolder'), icon: 'delete', variant: 'danger', onAction: () => onDelete(share) })
      return items
    }
    if (share.role === 'mirrored') {
      if (onOpenInFinder) items.push({ id: 'open-finder', label: t('share.openInFinder'), icon: 'folder_open', onAction: () => onOpenInFinder(share) })
      const enabled = share.mirrorEnabled !== false
      if (enabled && onPauseMirror) items.push({ id: 'pause', label: t('share.pauseMirror'), icon: 'pause', onAction: () => onPauseMirror(share) })
      if (!enabled && onResumeMirror) items.push({ id: 'resume', label: t('share.resumeMirror'), icon: 'play_arrow', onAction: () => onResumeMirror(share) })
      if (onChangeMirrorLocation) items.push({ id: 'change-location', label: t('share.changeMirrorLocation'), icon: 'edit', onAction: () => onChangeMirrorLocation(share) })
      if (onUnmount) items.push({ id: 'unmount', label: t('share.unmountMirror'), icon: 'close', variant: 'danger', onAction: () => onUnmount(share) })
      return items
    }
    if (onMirror) items.push({ id: 'mirror', label: t('share.mirrorToDisk'), icon: 'folder_download', onAction: () => onMirror(share) })
    return items
  })()

  return (
    <div className="group relative isolate flex items-center p-5 bg-surface-container-low dark:bg-surface-container-lowest hover:bg-surface-container-highest dark:hover:bg-surface-container-highest rounded-xl transition-colors">
      {/* Full-bleed navigation target so the whole card (incl. padding) opens the
          folder. `isolate` confines the action cluster's `z-10` to the card so it
          can't paint over the sticky section header; the content block is
          `pointer-events-none` so its positioned children (icon, avatar, badges)
          don't intercept clicks that should reach this overlay. */}
      <button
        type="button"
        onClick={() => onOpen(share)}
        aria-label={t('share.openFolder', { name: share.name })}
        className="absolute inset-0 rounded-xl cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
      />

      <div className="flex items-center gap-4 min-w-0 flex-grow pointer-events-none">
        <div className="relative w-12 h-12 shrink-0">
          <div className="w-12 h-12 bg-surface-container-high rounded-lg flex items-center justify-center">
            <Icon name="folder" className="text-accent" />
          </div>
          <div className="absolute -top-1 -right-1">
            <OwnerAvatar owner={owner} isYou={isYou} selfProfile={selfProfile} />
          </div>
          {share.role === 'mirrored' && (
            <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-surface-container-highest text-accent flex items-center justify-center border-2 border-surface-container-lowest">
              <Icon name="lock" size={10} />
            </div>
          )}
          {sourceMissing && (
            <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-warning text-on-warning flex items-center justify-center border-2 border-surface-container-lowest">
              <Icon name="warning" size={11} />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-grow">
          <p className="font-bold text-accent truncate">{share.name}</p>
          <p className="text-xs truncate mt-0.5 text-on-surface-variant">
            {sourceMissing ? t('share.mountPointGoneHint') : sizeLine}
          </p>
        </div>
      </div>

      <div className="shrink-0 ml-6 mr-3 flex items-center self-center">
        <Badge label={t(badge.labelKey)} classes={badge.classes} />
      </div>

      <div className="relative z-10 flex items-center gap-1 shrink-0">
        {menuItems.length > 0 && (
          <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <ActionMenu
              label={t('share.moreActions')}
              icon="more_vert"
              items={menuItems}
              triggerVariant="subtle"
              ariaLabel={t('share.moreActions')}
            />
          </div>
        )}
        <IconButton
          icon="chevron_right"
          iconSize={22}
          iconClassName="text-secondary"
          onClick={() => onOpen(share)}
          ariaLabel={t('share.browseFiles')}
          title={t('share.browseFiles')}
        />
      </div>
    </div>
  )
}

