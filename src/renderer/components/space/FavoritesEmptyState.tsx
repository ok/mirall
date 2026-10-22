import { Trans, useTranslation } from 'react-i18next'
import DocsCard from '../cards/DocsCard.js'
import Icon from '../primitives/Icon.js'
import Keycap from '../../keyboard/Keycap.js'
import { acceleratorFor, spaceDigitAccelerator } from '../../keyboard/known-commands.js'
import { ariaKeyShortcuts } from '../../keyboard/accelerator.js'
import { useKeyboard } from '../../keyboard/KeyboardProvider.js'

const TIP_CLASS = 'flex items-start gap-2 py-1.5 text-sm text-on-surface-variant leading-relaxed'

export default function FavoritesEmptyState() {
  const { t } = useTranslation()
  const { openCheatsheet } = useKeyboard()
  const showShortcuts = acceleratorFor('shortcuts.show')
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <h2 className="text-2xl font-headline font-bold text-accent mb-3">{t('spaces.emptyNoFavorites')}</h2>
      <DocsCard
        icon="star"
        title={t('spaces.favoritesDocsTitle')}
        body={t('spaces.favoritesDocsBody')}
        className="w-full max-w-md mt-8"
      >
        <ul className="space-y-1">
          <li className={TIP_CLASS}>
            <Icon name="keyboard" size={16} className="shrink-0 mt-0.5 text-secondary" />
            <span>
              <Trans
                i18nKey="spaces.favoritesTipJump"
                components={{ first: <Keycap spec={spaceDigitAccelerator(0)} />, last: <Keycap spec={spaceDigitAccelerator(8)} /> }}
              />
            </span>
          </li>
          <li className={TIP_CLASS}>
            <Icon name="star" size={16} className="shrink-0 mt-0.5 text-secondary" />
            <span>
              <Trans
                i18nKey="spaces.favoritesTipAdd"
                values={{ more: t('space.more'), add: t('space.addFavorite') }}
                components={{ menu: <strong className="font-semibold text-on-surface" />, palette: <Keycap spec={acceleratorFor('palette.open')} /> }}
              />
            </span>
          </li>
          <li>
            <button
              type="button"
              onClick={openCheatsheet}
              aria-keyshortcuts={showShortcuts ? ariaKeyShortcuts(showShortcuts) : undefined}
              className="flex items-center gap-2 rounded-lg -mx-1 px-1 py-1.5 text-sm font-headline font-bold text-secondary hover:underline focus-ring"
            >
              <Icon name="arrow_forward" size={16} className="shrink-0" />
              <span>{t('spaces.favoritesAllShortcuts')}</span>
              <Keycap spec={showShortcuts} ariaHidden />
            </button>
          </li>
        </ul>
      </DocsCard>
    </div>
  )
}
