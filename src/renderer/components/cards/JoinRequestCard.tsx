import { useTranslation } from 'react-i18next'
import type { JoinRequest } from '../../types.js'
import Avatar from '../primitives/Avatar.js'
import AvatarStack from '../primitives/AvatarStack.js'
import Button from '../primitives/Button.js'

interface JoinRequestBannerProps {
  requests: JoinRequest[]
  busyKeys: Set<string>
  onApprove: (publicKey: string) => void
  onDeny: (publicKey: string) => void
  onReview: () => void
}

export default function JoinRequestCard({ requests, busyKeys, onApprove, onDeny, onReview }: JoinRequestBannerProps) {
  const { t } = useTranslation()
  if (requests.length === 0) return null

  if (requests.length === 1) {
    const r = requests[0]
    const acting = busyKeys.has(r.publicKey)
    return (
      <div role="status" aria-live="polite" className="rounded-2xl p-4 flex items-center gap-3 bg-surface-container-low">
        <Avatar src={r.avatar} displayName={r.displayName} size="md" ring="status" statusVariant="connecting" />
        <p className="flex-1 min-w-0 font-bold text-accent truncate">{t('space.oneWantsToJoin', { name: r.displayName })}</p>
        <Button variant="primary" icon="check" disabled={acting} onClick={() => onApprove(r.publicKey)} ariaLabel={t('member.approveNamed', { name: r.displayName })}>
          {t('member.approve')}
        </Button>
        <Button variant="danger" disabled={acting} onClick={() => onDeny(r.publicKey)} ariaLabel={t('member.denyNamed', { name: r.displayName })}>
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
        overflow={Math.max(0, requests.length - 3)}
        avatars={requests.slice(0, 3).map((r) => ({
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
