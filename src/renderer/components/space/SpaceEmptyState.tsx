import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import DocsCard from '../widgets/DocsCard.js'

/**
 * The first thing a member of an empty space sees: the two things that can go in one, and the
 * three docs pages that say how. Shown only once BOTH lists have loaded empty — see
 * spaceContentState.js for why emptiness needs both.
 */
export default function SpaceEmptyState() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col min-h-[24rem] mt-12">
      <div className="h-[10.5rem] flex items-center justify-end gap-5 pr-12">
        <Icon name="draft" size={45} className="text-secondary" />
        <Icon name="folder" filled size={45} className="text-secondary" />
        <svg
          viewBox="0 0 512 256"
          className="w-[6.5rem] h-[3.25rem] text-secondary ml-1"
          fill="none"
          stroke="currentColor"
          strokeWidth="28"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="60,80 140,128 60,176" opacity="0.35" />
          <polyline points="200,80 280,128 200,176" opacity="0.65" />
          <polyline points="340,80 420,128 340,176" opacity="1" />
        </svg>
      </div>
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
