// Changelog dialog shown after an update (or on request): renders release-note
// markdown from the whats-new store and records dismissal.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { marked } from 'marked'
import * as whatsNew from '../../whats-new.js'
import { dismissChangelog, type ChangelogEntry } from '../../changelog.js'
import type { WhatsNewState } from '../../whats-new.js'
import { useHasVerticalOverflow } from '../../hooks/useHasVerticalOverflow.js'
import Modal from '../primitives/Modal.js'
import IconButton from '../primitives/IconButton.js'
import Button from '../primitives/Button.js'

interface RenderedEntry {
  version: string
  html: string
}

function render(entries: ChangelogEntry[]): RenderedEntry[] {
  return entries.map((e) => ({
    version: e.version,
    html: marked(e.body, { async: false }),
  }))
}

export default function WhatsNewModal() {
  const { t } = useTranslation()
  const [state, setState] = useState<WhatsNewState | null>(null)
  const { ref: scrollRef, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()

  useEffect(() => whatsNew.subscribe(setState), [])

  const rendered = useMemo<RenderedEntry[]>(
    () => (state ? render(state.entries) : []),
    [state],
  )

  if (!state) return null
  const introKey = state.mode === 'all' ? 'whatsNew.introAll' : 'whatsNew.introUpdate'

  function handleDismiss() {
    dismissChangelog()
    whatsNew.close()
  }

  return (
    <Modal isOpen onClose={handleDismiss} ariaLabel={t('whatsNew.title')} panelClassName="glass-modal w-full max-w-2xl max-h-[80vh] rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative flex flex-col">
      <>
        <div className="px-10 pt-10 pb-6 shrink-0">
          <div className="flex justify-between items-start mb-2">
            <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight">
              {t('whatsNew.title')}
            </h1>
            <IconButton
              icon="close"
              onClick={handleDismiss}
              ariaLabel={t('actions.close')}
              iconClassName="text-secondary"
            />
          </div>
          <p className="text-on-surface-variant font-medium text-sm">
            {t(introKey)}
          </p>
        </div>
        <div
          ref={scrollRef}
          tabIndex={0}
          role="region"
          aria-label={t('whatsNew.title')}
          className={`px-10 pb-6 space-y-8 overflow-y-auto scrollbar-thin focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-secondary/30${hasOverflow ? ' pr-6' : ''}`}
        >
          {rendered.map((e) => (
            <section key={e.version}>
              <h2 className="font-headline text-xl font-bold text-accent mb-3">v{e.version}</h2>
              <div
                className="whats-new-body text-on-surface text-sm leading-relaxed space-y-3"
                dangerouslySetInnerHTML={{ __html: e.html }}
              />
            </section>
          ))}
        </div>
        <div className="px-10 pb-10 pt-4 shrink-0">
          <Button size="lg" fullWidth onClick={handleDismiss}>
            {t('whatsNew.gotIt')}
          </Button>
        </div>
      </>
    </Modal>
  )
}
