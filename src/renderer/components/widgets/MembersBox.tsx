import { useTranslation } from 'react-i18next'
import type { SpaceMember } from '../../types.js'
import CollapsibleCard from '../primitives/CollapsibleCard.js'
import MemberCard from '../cards/MemberCard.js'
import AvatarStack from '../primitives/AvatarStack.js'
import TextButton from '../primitives/TextButton.js'
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
            className="min-h-0 overflow-y-auto scrollbar-thin pr-2 space-y-6 rounded-lg focus-ring"
          >
            {members.map((member) => (
              <MemberCard key={member.publicKey} member={member} />
            ))}
          </div>
          <div className="pt-4 shrink-0 flex justify-end">
            <TextButton onClick={() => setExpanded(false)} ariaExpanded={true}>
              {t('space.showFewerMembers')}
            </TextButton>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-between gap-3">
          {/* Each face reads its own name here — the collapsed box has no other place that says
              who the members are. */}
          <AvatarStack
            size="md"
            surface="surface-container-low"
            announce="each"
            label={t('space.membersAndMore', { count: overflow })}
            overflow={overflow}
            avatars={stack.map((member) => ({
              key: member.publicKey,
              src: member.avatar,
              displayName: member.displayName,
              title: member.displayName || undefined,
            }))}
          />
          <TextButton onClick={() => setExpanded(true)} ariaExpanded={false}>
            {t('space.showAllMembers')}
          </TextButton>
        </div>
      )}
    </CollapsibleCard>
  )
}
