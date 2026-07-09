// General settings: minimize-to-tray and open-at-login toggles persisted via main's app prefs.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import type { AppPrefs } from '../global.js'
import Icon from '../components/primitives/Icon.js'
import PageHeader from '../components/layout/PageHeader.js'
import Toggle from '../components/primitives/Toggle.js'

interface GeneralSettingsProps {
  onBack: () => void
}

export default function GeneralSettings({ onBack }: GeneralSettingsProps) {
  const { t } = useTranslation()
  const [prefs, setLocalPrefs] = useState<AppPrefs | null>(null)
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const isMac = window.bridge.getPlatform() === 'darwin'
  const introKey = isMac ? 'generalSettings.introMac' : 'generalSettings.intro'
  const minimizeKey = isMac ? 'generalSettings.minimizeToTrayMac' : 'generalSettings.minimizeToTray'
  const minimizeDescKey = isMac ? 'generalSettings.minimizeToTrayDescMac' : 'generalSettings.minimizeToTrayDesc'

  useEffect(() => {
    let cancelled = false
    window.bridge.getPrefs().then((p) => { if (!cancelled) setLocalPrefs(p) })
    return () => { cancelled = true }
  }, [])

  async function update(partial: Partial<AppPrefs>) {
    if (!prefs) return
    const optimistic = { ...prefs, ...partial }
    setLocalPrefs(optimistic)
    const next = await window.bridge.setPrefs(partial)
    setLocalPrefs(next)
  }

  return (
    <div
      ref={ref}
      className={`h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader
          title={t('generalSettings.title')}
          subtitle={t(introKey)}
          onBack={onBack}
        />

        <div className="space-y-10">
          <section>
            <div className="bg-surface-container-low rounded-xl overflow-hidden">
              <Toggle
                label={t(minimizeKey)}
                description={t(minimizeDescKey)}
                checked={prefs?.minimizeToTray ?? true}
                disabled={!prefs}
                onChange={(v) => update({ minimizeToTray: v })}
              />
              <Toggle
                label={t('generalSettings.openAtLogin')}
                description={t('generalSettings.openAtLoginDesc')}
                checked={prefs?.openAtLogin ?? false}
                disabled={!prefs}
                onChange={(v) => update({ openAtLogin: v })}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
