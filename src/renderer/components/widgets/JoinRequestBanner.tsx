import { useTranslation } from 'react-i18next'
import type { JoinRequest } from '../../types.js'
import Avatar from '../primitives/Avatar.js'
import Button from '../primitives/Button.js'

interface JoinRequestBannerProps {
  requests: JoinRequest[]
  busyKeys: Set<string>
  onApprove: (publicKey: string) => void
  onDeny: (publicKey: string) => void
  onReview: () => void
}

export default function JoinRequestBanner({ requests, busyKeys, onApprove, onDeny, onReview }: JoinRequestBannerProps) {
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
      <div className="flex items-center -space-x-3 shrink-0">
        {requests.slice(0, 3).map((r) => (
          <Avatar key={r.publicKey} src={r.avatar} displayName={r.displayName} size="md" ring="surface-container-low" />
        ))}
        {requests.length > 3 && (
          <div
            aria-hidden="true"
            style={{ boxShadow: '0 0 0 2px var(--color-surface-container-low)' }}
            className="w-9 h-9 rounded-full bg-surface-container-highest flex items-center justify-center text-xs font-bold text-on-surface-variant"
          >
            +{requests.length - 3}
          </div>
        )}
      </div>
      <p className="flex-1 font-bold text-accent">{t('space.nWantToJoin', { count: requests.length })}</p>
      <Button variant="primary" onClick={onReview}>{t('space.reviewN', { count: requests.length })}</Button>
    </div>
  )
}
