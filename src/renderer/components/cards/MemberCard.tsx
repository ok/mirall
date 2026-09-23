import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { SpaceMember } from '../../types/types.js'
import { memberPresence, MEMBER_PRESENCE, PRESENCE_LABEL } from '../../model/member-presence.js'
import Icon from '../primitives/Icon.js'
import Avatar from '../primitives/Avatar.js'

interface MemberCardProps {
  member: SpaceMember
}

function MemberCard({ member }: MemberCardProps) {
  const { t } = useTranslation()
  const presence = memberPresence(member)
  const isOnline = presence !== MEMBER_PRESENCE.OFFLINE

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="relative">
          <Avatar src={member.avatar} displayName={member.displayName} size="lg" />
          <div aria-hidden="true" className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-surface-container-low ${isOnline ? 'bg-online' : 'bg-offline'}`} />
        </div>
        <div>
          <p className={`font-bold ${isOnline ? 'text-accent' : 'text-outline'}`}>{member.displayName || t('member.unknown')}</p>
          <p className="text-xs text-on-surface-variant">{t(PRESENCE_LABEL[presence])}</p>
        </div>
      </div>
      {isOnline && (
        <Icon name={presence === MEMBER_PRESENCE.RELAYED ? 'hub' : 'check_circle'} className="text-on-surface-variant opacity-30" />
      )}
    </div>
  )
}

// memo: `member` keeps its identity while the roster is unchanged (useMembers memoizes it); a
// presence or reach transition rebuilds the roster, which is correct (src/renderer/hooks/README.md).
export default memo(MemberCard)
