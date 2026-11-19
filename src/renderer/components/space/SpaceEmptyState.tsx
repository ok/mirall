import { useTranslation } from 'react-i18next'
import DocsCard from '../cards/DocsCard.js'

/**
 * The first thing a member of an empty space sees: the two things that can go in one, and the
 * three docs pages that say how. Shown only once BOTH lists have loaded empty — see
 * spaceContentState.js for why emptiness needs both.
 */
export default function SpaceEmptyState() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col min-h-[24rem] mt-12">
      <div className="flex-1 flex flex-col items-center justify-center text-center px-10 pb-10">
        <h2 className="text-2xl font-headline font-bold text-accent mb-3">
          {t('space.emptyShareTitle')}
        </h2>
        <p className="text-on-surface-variant max-w-md leading-relaxed">
          {t('space.emptyShareSubtitle')}
        </p>
        <DocsCard
          icon="menu_book"
          title={t('space.emptyShareDocsTitle')}
          body={t('space.emptyShareDocsBody')}
          className="w-full max-w-md mt-8"
          links={[
            { target: { page: 'explanation', anchor: 'spaces-members-availability' }, label: t('docs.availability') },
            { target: { page: 'guides', anchor: 'share-files' }, label: t('docs.shareFiles') },
            { target: { page: 'guides', anchor: 'share-a-folder' }, label: t('docs.shareFolder') },
          ]}
        />
      </div>
    </div>
  )
}
