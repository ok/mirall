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

// One settled member in the expanded "who has it" list, at PeerDownloadRow's height and anatomy: the
// state reads as one sentence to assistive tech, since there is no progress left to announce.
export default function RecipientRow({ member, receivedAt, earlier }: RecipientRowProps) {
  const { t } = useTranslation()
  const name = member.displayName || t('member.unknown')
  const online = member.online !== false
  const when = receivedAt !== undefined ? formatWhen(receivedAt) : null
  const meta = when ?? (earlier ? t('file.recipientEarlier') : t(online ? 'member.online' : 'member.offline'))
  const sentence = when
    ? t('file.recipientHasIt', { name, when })
    : earlier ? t('file.recipientEarlierSr', { name }) : t(online ? 'file.recipientMissingOnline' : 'file.recipientMissingOffline', { name })

  return (
    <li className="h-12 flex items-center gap-3 px-1">
      <span className="sr-only">{sentence}</span>
      <span aria-hidden="true" className={`min-w-0 ml-auto text-sm font-bold truncate ${online ? 'text-accent' : 'text-outline'}`}>{name}</span>
      <span aria-hidden="true" className="relative shrink-0">
        <Avatar src={member.avatar} displayName={name} size="sm" />
        <span className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-surface-container-lowest ${online ? 'bg-online' : 'bg-offline'}`} />
      </span>
      <span aria-hidden="true" className="w-1/2 shrink-0 flex items-center justify-end gap-1.5 text-[11px] leading-none text-on-surface-variant">
        {when && <Icon name="check_circle" size={14} className="text-on-success shrink-0" />}
        <span className="truncate">{meta}</span>
      </span>
    </li>
  )
}
