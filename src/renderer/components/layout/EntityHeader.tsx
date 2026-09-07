import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import IconButton from '../primitives/IconButton.js'

// The header of a screen ABOUT SOMETHING — a space, a folder — as opposed to PageHeader, which titles
// a settings page. The difference is not decoration: this title carries a name someone typed, so it
// truncates, and `truncate` is `overflow: hidden`, which clips the 800-weight headline's descenders
// unless the line box is loosened and given room below the baseline. That triple
// (truncate + leading-tight + pb-1.5) is what makes this a second component rather than a flag on the
// first, and test/unit/space-title-descender.test.js pins it.
interface EntityHeaderProps {
  name: string
  titleAdornment?: ReactNode
  eyebrow?: ReactNode
  actions?: ReactNode
  onBack: () => void
}

export default function EntityHeader({ name, titleAdornment, eyebrow, actions, onBack }: EntityHeaderProps) {
  const { t } = useTranslation()
  return (
    <div className="shrink-0 pt-8 pb-4">
      <div className="flex items-start gap-4">
        <IconButton
          icon="arrow_back"
          onClick={onBack}
          ariaLabel={t('actions.back')}
          className="mt-1 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-4xl font-headline font-extrabold text-accent tracking-tighter leading-tight truncate pb-1.5">
              {name}
            </h1>
            {titleAdornment}
          </div>
          {eyebrow && (
            <p className="text-xs font-bold text-secondary tracking-wide uppercase mt-1">{eyebrow}</p>
          )}
        </div>
        {actions && <div className="flex gap-3 mt-2 shrink-0">{actions}</div>}
      </div>
    </div>
  )
}
