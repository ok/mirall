// A real anchor, not a button: the main process turns an http(s) navigation into
// shell.openExternal, so no bridge call is needed, and the destination belongs in the
// accessible name because the only other signal is a decorative glyph. The anchor is
// `relative` so the sr-only span — which is position:absolute — resolves against it
// rather than the initial containing block, where its static position inside a scrolled
// container would extend the document's own scroll area.
import { useTranslation } from 'react-i18next'
import { docsUrl, type DocsTarget } from '../../docs-links.js'
import Icon from '../primitives/Icon.js'

interface DocsLinkProps {
  target: DocsTarget
  label: string
}

export default function DocsLink({ target, label }: DocsLinkProps) {
  const { t } = useTranslation()
  return (
    <a
      href={docsUrl(target)}
      className="relative flex items-center gap-2 rounded-lg -mx-1 px-1 py-1.5 text-sm font-headline font-bold text-secondary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
    >
      <Icon name="arrow_forward" size={16} className="shrink-0" />
      <span>{label}</span>
      <Icon name="open_in_new" size={14} className="shrink-0 opacity-60" />
      <span className="sr-only">{t('docs.opensInBrowser')}</span>
    </a>
  )
}
