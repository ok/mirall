// "Learn more" card for the empty states. The documentation is English-only while the app
// ships five languages, so a non-English UI gets one note at the foot of the card rather
// than a language suffix on every link.
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { docsUrl, type DocsTarget } from '../../docs-links.js'
import Icon, { type IconName } from '../primitives/Icon.js'
import DocsLink from './DocsLink.js'

interface DocsCardEntry {
  target: DocsTarget
  label: string
}

interface DocsCardProps {
  icon: IconName
  title: string
  body: string
  links: DocsCardEntry[]
  className?: string
}

export default function DocsCard({ icon, title, body, links, className }: DocsCardProps) {
  const { t, i18n } = useTranslation()
  const headingId = useId()
  const showEnglishNote = !(i18n.language ?? 'en').startsWith('en')

  return (
    <section
      aria-labelledby={headingId}
      className={`bg-surface-container-low rounded-xl p-6 text-left${className ? ` ${className}` : ''}`}
    >
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-full bg-icon-tile flex items-center justify-center text-on-icon-tile shrink-0">
          <Icon name={icon} size={20} />
        </div>
        <div className="min-w-0">
          <h3 id={headingId} className="font-headline font-bold text-accent mb-1">{title}</h3>
          <p className="text-sm text-on-surface-variant leading-relaxed mb-4">{body}</p>
          <ul className="space-y-1">
            {links.map((link) => (
              <li key={docsUrl(link.target)}>
                <DocsLink target={link.target} label={link.label} />
              </li>
            ))}
          </ul>
          {showEnglishNote && (
            <p className="text-xs text-on-surface-variant mt-4">{t('docs.englishNote')}</p>
          )}
        </div>
      </div>
    </section>
  )
}
