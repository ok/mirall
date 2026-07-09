// About screen: app version, staged-update notice, "What's new" changelog access, and feedback links.
import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useUpdates } from '../hooks/useUpdates.js'
import CopyButton from '../components/primitives/CopyButton.js'
import Icon, { type IconName } from '../components/primitives/Icon.js'
import PageHeader from '../components/layout/PageHeader.js'
import SectionHeading from '../components/layout/SectionHeading.js'
import { loadAllEntries } from '../changelog.js'
import * as whatsNew from '../whats-new.js'
import { useKeyboard } from '../keyboard/KeyboardProvider.js'

interface AboutSettingsProps {
  onBack: () => void
  onFeedback: () => void
}

export default function AboutSettings({ onBack, onFeedback }: AboutSettingsProps) {
  const { t } = useTranslation()
  const { openCheatsheet } = useKeyboard()
  const { update } = useUpdates()
  const [version, setVersion] = useState('')
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()

  useEffect(() => {
    const sem = window.bridge.pkg().version || '0.0.0'
    // The baked package.json version uniquely identifies the running build on
    // every channel (`-beta.N` = CI run, bare semver = prod tag, `(dev)` =
    // source). Do NOT append appVersion()'s (fork.length): that reads the OTA
    // drive head — the latest length available on the seed — not the version
    // installed here, so it read as a confusing mismatch (e.g.
    // "v1.6.0-beta.82 (0.22326)") whenever an update was staged but not yet run.
    setVersion(window.bridge.isDev() ? `v${sem} (dev)` : `v${sem}`)
  }, [])

  // Permanent counterpart to the dismissable banner: while an update is staged,
  // the About box always says which version is waiting, even after the banner
  // is dismissed. `update` here is the raw fact (dismissal is not applied).
  const pendingVersion = update
    ? (update.version.semver ?? `${update.version.fork}.${update.version.length}`)
    : null

  async function openWhatsNew() {
    const all = await loadAllEntries()
    if (all.length) whatsNew.open(all, 'all')
  }

  const links: Array<{ icon: IconName; label: string; desc: string; action?: () => void; href?: string; external: boolean }> = [
    { icon: 'auto_awesome', label: t('aboutSettings.whatsNew'), desc: t('aboutSettings.whatsNewDesc'), action: openWhatsNew, external: false },
    { icon: 'keyboard', label: t('aboutSettings.keyboardShortcuts'), desc: t('aboutSettings.keyboardShortcutsDesc'), action: openCheatsheet, external: false },
    { icon: 'menu_book', label: t('aboutSettings.documentation'), desc: t('aboutSettings.documentationDesc'), href: 'https://mirall.app/docs', external: true },
    { icon: 'feedback', label: t('aboutSettings.sendFeedback'), desc: t('aboutSettings.sendFeedbackDesc'), action: onFeedback, external: false },
  ]

  return (
    <div
      ref={ref}
      className={`h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
      <PageHeader
        title={t('aboutSettings.title')}
        subtitle={t('aboutSettings.intro')}
        onBack={onBack}
      />

      <div className="space-y-10">
        <section>
          <SectionHeading>{t('aboutSettings.version')}</SectionHeading>
          <div className="group/copy bg-surface-container-low rounded-xl p-6 flex items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-icon-tile flex items-center justify-center text-on-icon-tile">
              <Icon name="info" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-semibold text-accent">Mirall {version || '...'}</p>
                {version && (
                  <CopyButton
                    value={`Mirall ${version}`}
                    className="opacity-0 group-hover/copy:opacity-100 focus:opacity-100 transition-opacity"
                  />
                )}
              </div>
              {pendingVersion && (
                <p className="text-xs text-secondary mt-1 flex items-center gap-1">
                  <Icon name="update" size={14} />
                  {t('aboutSettings.updateReady', { version: pendingVersion })}
                </p>
              )}
            </div>
          </div>
        </section>

        <section>
          <SectionHeading>{t('aboutSettings.resources')}</SectionHeading>
          <div className="bg-surface-container-low rounded-xl overflow-hidden">
            {links.map((item) => {
              const cls = 'w-full text-left p-6 flex items-center justify-between hover:bg-surface-container-high/50 active:scale-[0.99] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-secondary/30'
              const inner = (
                <>
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-icon-tile flex items-center justify-center text-on-icon-tile">
                      <Icon name={item.icon} />
                    </div>
                    <div>
                      <p className="font-semibold text-accent">{item.label}</p>
                      <p className="text-xs text-on-surface-variant">{item.desc}</p>
                    </div>
                  </div>
                  <Icon name={item.external ? 'open_in_new' : 'chevron_right'} className="text-secondary" />
                </>
              )
              return item.href ? (
                <a key={item.label} href={item.href} target="_blank" rel="noreferrer" aria-label={`${item.label} (${t('a11y.opensExternal')})`} className={cls}>{inner}</a>
              ) : (
                <button key={item.label} type="button" onClick={item.action} aria-label={item.label} className={cls}>{inner}</button>
              )
            })}
          </div>
        </section>
      </div>
      </div>
    </div>
  )
}
