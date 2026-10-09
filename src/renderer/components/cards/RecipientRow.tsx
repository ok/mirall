import { useTranslation } from 'react-i18next'
import type { SpaceMember } from '../../types/types.js'
import { formatWhen } from '../../format/utils.js'
import Avatar from '../primitives/Avatar.js'
import Icon from '../primitives/Icon.js'

interface RecipientRowProps {
  member: SpaceMember
  /** When they received the current version; absent for a member who does not hold it. */
  receivedAt?: number
  /** Holds a version the file has since replaced. */
  earlier?: boolean
}

// One settled member in the expanded "who has it" list, as a pill; its group's icon says whether they
// hold the current version. The state reads as one sentence to assistive tech, since there is no
// progress left to announce. The pill's fill stands off the card at rest and under its hover lift:
// light has no one token that clears both, so it turns white while the card is lifted.
export default function RecipientRow({ member, receivedAt, earlier }: RecipientRowProps) {
  const { t } = useTranslation()
  const name = member.displayName || t('member.unknown')
  const online = member.online !== false
  const when = receivedAt !== undefined ? formatWhen(receivedAt) : null
  const sentence = when
    ? t('file.recipientHasIt', { name, when })
    : earlier ? t('file.recipientEarlierSr', { name }) : t(online ? 'file.recipientMissingOnline' : 'file.recipientMissingOffline', { name })

  return (
    <li title={sentence} className="max-w-full h-7 inline-flex items-center gap-1.5 pl-1 pr-2.5 rounded-full bg-surface-container-high group-hover:bg-surface-container-lowest dark:group-hover:bg-surface-container-high transition-colors">
      <span className="sr-only">{sentence}</span>
      <span aria-hidden="true" className="relative shrink-0">
        <Avatar src={member.avatar} displayName={name} size="xs" />
        <span className={`absolute -bottom-px -right-px w-2 h-2 rounded-full border-[1.5px] border-surface-container-high group-hover:border-surface-container-lowest dark:group-hover:border-surface-container-high transition-colors ${online ? 'bg-online' : 'bg-offline'}`} />
      </span>
      <span aria-hidden="true" className="min-w-0 text-xs font-semibold text-on-surface-variant truncate">{name}</span>
      {when && (
        <span aria-hidden="true" className="shrink-0 text-[11px] leading-none text-on-surface-variant tabular-nums">{when}</span>
      )}
      {earlier && !when && <Icon name="history" size={13} className="text-on-surface-variant shrink-0" />}
    </li>
  )
}
