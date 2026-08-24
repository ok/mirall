import { useTranslation } from 'react-i18next'
import type { SpaceMember } from '../../types.js'
import CollapsibleCard from '../primitives/CollapsibleCard.js'
import MemberCard from '../cards/MemberCard.js'
import Avatar from '../primitives/Avatar.js'
import { summarizeMembers } from '../../memberSummary.js'
import { useSpaceCardState } from '../../hooks/useSpaceCardState.js'

interface MembersBoxProps {
  spaceId: string
  members: SpaceMember[]
}

export default function MembersBox({ spaceId, members }: MembersBoxProps) {
  const { t } = useTranslation()
  // The card's fold and the stack-vs-list choice inside it are independent, and both
  // are restored per space: a collapsed card can hold an expanded list underneath.
  const [open, setOpen] = useSpaceCardState(spaceId, 'membersOpen')
  const [expanded, setExpanded] = useSpaceCardState(spaceId, 'membersExpanded')
  const { stack, overflow } = summarizeMembers(members, { stackMax: 8 })

  return (
    <CollapsibleCard
      icon="group"
      title={t('space.members')}
      count={members.length}
      open={open}
      onOpenChange={setOpen}
      fill={expanded}
    >
      {members.length === 0 ? (
        <p className="text-on-surface-variant text-sm py-4">{t('space.emptyMembers')}</p>
      ) : expanded ? (
        <>
          <div
            role="region"
            tabIndex={0}
            aria-label={t('space.membersList')}
            className="min-h-0 overflow-y-auto scrollbar-thin pr-2 space-y-6 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
          >
            {members.map((member) => (
              <MemberCard key={member.publicKey} member={member} />
            ))}
          </div>
          <div className="pt-4 shrink-0">
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-expanded={true}
              className="text-secondary font-bold rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
            >
              {t('space.showFewerMembers')}
            </button>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-3">
          <div className="flex items-center">
            {stack.map((member, i) => (
              <span
                key={member.publicKey}
                title={member.displayName || undefined}
                className={i === 0 ? '' : '-ml-3'}
              >
                <Avatar
                  src={member.avatar}
                  displayName={member.displayName}
                  size="md"
                  ring="surface-container-low"
                />
              </span>
            ))}
            {overflow > 0 && (
              <div
                role="img"
                aria-label={t('space.membersAndMore', { count: overflow })}
                style={{ boxShadow: '0 0 0 2px var(--color-surface-container-low)' }}
                className="-ml-3 w-9 h-9 rounded-full bg-surface-container-highest text-on-surface-variant flex items-center justify-center font-bold text-sm"
              >
                <span aria-hidden="true">+{overflow}</span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-expanded={false}
            className="ml-auto text-secondary font-bold rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
          >
            {t('space.showAllMembers')}
          </button>
        </div>
      )}
    </CollapsibleCard>
  )
}
