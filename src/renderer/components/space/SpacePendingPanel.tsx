import { useTranslation } from 'react-i18next'
import AvatarStack from '../primitives/AvatarStack.js'
import DocsCard from '../widgets/DocsCard.js'
import type { SpaceMember } from '../../types.js'

interface SpacePendingPanelProps {
  spaceName: string
  /** The roster minus ourselves: the people who can approve the request. */
  inviters: SpaceMember[]
}

/**
 * What a space looks like before the request to join it is answered. No content, because we have
 * no read key yet — only who is on the other side and what happens next.
 */
export default function SpacePendingPanel({ spaceName, inviters }: SpacePendingPanelProps) {
  const { t } = useTranslation()
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center pb-8">
      {inviters.length > 0 ? (
        <AvatarStack
          className="mb-5"
          size="xl"
          surface="surface-container-lowest"
          announce="each"
          overflow={0}
          avatars={inviters.slice(0, 3).map((m) => ({
            key: m.publicKey,
            src: m.avatar,
            displayName: m.displayName,
          }))}
        />
      ) : null}
      {/* The live region covers only the two strings that change; the card below is
          static and would be re-announced on every render from inside it. */}
      <div role="status" aria-live="polite" className="flex flex-col items-center">
        <h2 className="text-2xl font-headline font-bold text-accent mb-3">
          {t('space.waitingApproval', { name: spaceName })}
        </h2>
        <p className="text-on-surface-variant max-w-md leading-relaxed">{t('space.waitingApprovalHint')}</p>
      </div>
      <DocsCard
        icon="lock"
        title={t('space.waitingDocsTitle')}
        body={t('space.waitingDocsBody')}
        className="w-full max-w-lg mt-8"
        links={[
          { target: { page: 'explanation', anchor: 'membership-approval' }, label: t('docs.membershipApproval') },
          { target: { page: 'guides', anchor: 'fix-a-stuck-join' }, label: t('docs.stuckJoin') },
        ]}
      />
    </div>
  )
}
