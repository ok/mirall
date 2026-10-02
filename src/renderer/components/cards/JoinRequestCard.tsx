import { useTranslation } from 'react-i18next'
import type { JoinRequest } from '../../types/types.js'
import Avatar from '../primitives/Avatar.js'
import AvatarStack from '../primitives/AvatarStack.js'
import Button from '../primitives/Button.js'
import { useHeldControl } from '../../hooks/useHeldControl.js'

interface JoinRequestBannerProps {
  requests: JoinRequest[]
  busyKeys: Set<string>
  onApprove: (publicKey: string) => void
  onDeny: (publicKey: string) => void
  onReview: () => void
  // While a restore is being confirmed, requests are shown but answered afterwards.
  writeHeld?: boolean
}

export default function JoinRequestCard({ requests, busyKeys, onApprove, onDeny, onReview, writeHeld = false }: JoinRequestBannerProps) {
  const { t } = useTranslation()
  const held = useHeldControl(writeHeld)
  if (requests.length === 0) return null

  if (requests.length === 1) {
    const r = requests[0]
    const acting = busyKeys.has(r.publicKey)
    return (
      <div role="status" aria-live="polite" className="rounded-2xl p-4 flex items-center gap-3 bg-surface-container-low">
        <Avatar src={r.avatar} displayName={r.displayName} size="md" ring="status" statusVariant="connecting" />
        <p className="flex-1 min-w-0 font-bold text-accent truncate">{t('space.oneWantsToJoin', { name: r.displayName })}</p>
        <Button variant="primary" icon="check" disabled={acting} onClick={held.guard(() => onApprove(r.publicKey))} ariaLabel={t('member.approveNamed', { name: r.displayName })} {...held.attrs}>
          {t('member.approve')}
        </Button>
        <Button variant="danger" disabled={acting} onClick={held.guard(() => onDeny(r.publicKey))} ariaLabel={t('member.denyNamed', { name: r.displayName })} {...held.attrs}>
          {t('member.deny')}
        </Button>
      </div>
    )
  }

  return (
    <div role="status" aria-live="polite" className="rounded-2xl p-4 flex items-center gap-3 bg-surface-container-low">
      <AvatarStack
        className="shrink-0"
        size="md"
        surface="surface-container-low"
        announce="each"
        max={3}
        avatars={requests.map((r) => ({
          key: r.publicKey,
          src: r.avatar,
          displayName: r.displayName,
        }))}
      />
      <p className="flex-1 font-bold text-accent">{t('space.nWantToJoin', { count: requests.length })}</p>
      <Button variant="primary" onClick={onReview}>{t('space.reviewN', { count: requests.length })}</Button>
    </div>
  )
}
