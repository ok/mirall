import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import type { SpaceMember } from '../../types.js'
import Icon from '../primitives/Icon.js'
import Avatar from '../primitives/Avatar.js'

interface MemberCardProps {
  member: SpaceMember
}

function MemberCard({ member }: MemberCardProps) {
  const { t } = useTranslation()
  const isOnline = member.online !== false

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="relative">
          <Avatar src={member.avatar} displayName={member.displayName} size="lg" />
          <div aria-hidden="true" className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-surface-container-low ${isOnline ? 'bg-online' : 'bg-offline'}`} />
        </div>
        <div>
          <p className={`font-bold ${isOnline ? 'text-accent' : 'text-outline'}`}>{member.displayName || t('member.unknown')}</p>
          <p className="text-xs text-on-surface-variant">{isOnline ? t('member.online') : t('member.offline')}</p>
        </div>
      </div>
      {isOnline && (
        <Icon name="check_circle" className="text-on-surface-variant opacity-30" />
      )}
    </div>
  )
}

// `member` is the only prop and it keeps its identity while the roster is unchanged (useMembers
// memoizes the projection), so this row sits out the decoration heartbeat entirely. A presence
// transition rebuilds every member object and re-renders the roster, which is correct.
export default memo(MemberCard)
