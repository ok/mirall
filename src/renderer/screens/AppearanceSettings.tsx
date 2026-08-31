// Appearance settings: theme (light/dark/system), language, and UI zoom.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n, { setLocale, SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n.js'
import { applyTheme, getStoredTheme, type ThemeMode } from '../theme.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { usePrefs } from '../store/usePrefs.js'
import { useZoom, ZOOM_LEVELS, isSameZoom } from '../hooks/useZoom.js'
import Icon from '../components/primitives/Icon.js'
import PageHeader from '../components/layout/PageHeader.js'
import SectionHeading from '../components/layout/SectionHeading.js'
import Toggle from '../components/primitives/Toggle.js'

interface AppearanceSettingsProps {
  onBack: () => void
}

export default function AppearanceSettings({ onBack }: AppearanceSettingsProps) {
  const { t } = useTranslation()
  const [theme, setTheme] = useState<ThemeMode>(() => getStoredTheme())
  const { zoom, setZoom } = useZoom()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const currentLang = i18n.language
  const showMenuBarToggle = window.bridge.getPlatform() !== 'darwin'
  // macOS has no menu-bar toggle, and prefs are read here for nothing else — so this screen does
  // not pull them there. Everywhere else it shares the one copy with GeneralSettings.
  const { prefs, update: updatePrefs } = usePrefs({ enabled: showMenuBarToggle })

  function handleTheme(mode: ThemeMode) {
    setTheme(mode)
    applyTheme(mode)
  }

  return (
    <div
      ref={ref}
      className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader
          title={t('appearanceSettings.title')}
          subtitle={t('appearanceSettings.intro')}
          onBack={onBack}
        />

        <div className="space-y-10">
          <section>
            <SectionHeading>{t('appearanceSettings.lookAndFeel')}</SectionHeading>
            <div className="bg-surface-container-low rounded-xl p-6 space-y-6">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-accent">{t('appearanceSettings.themeMode')}</p>
                <div className="flex bg-surface-container-high dark:bg-surface-container-highest p-1 rounded-full">
                  <button
                    onClick={() => handleTheme('light')}
                    aria-label={t('appearanceSettings.themeLight')}
                    aria-pressed={theme === 'light'}
                    className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${
                      theme === 'light' ? 'bg-surface-container-lowest shadow-sm text-accent font-semibold' : 'text-on-surface-variant hover:text-accent font-medium'
                    }`}
                  >
                    <Icon name="light_mode" size={14} />
                    {t('appearanceSettings.themeLight')}
                  </button>
                  <button
                    onClick={() => handleTheme('system')}
                    aria-label={t('appearanceSettings.themeSystem')}
                    aria-pressed={theme === 'system'}
                    className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${
                      theme === 'system' ? 'bg-surface-container-lowest shadow-sm text-accent font-semibold' : 'text-on-surface-variant hover:text-accent font-medium'
                    }`}
                  >
                    <Icon name="computer" size={14} />
                    {t('appearanceSettings.themeSystem')}
                  </button>
                  <button
                    onClick={() => handleTheme('dark')}
                    aria-label={t('appearanceSettings.themeDark')}
                    aria-pressed={theme === 'dark'}
                    className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${
                      theme === 'dark' ? 'bg-surface-container-lowest shadow-sm text-accent font-semibold' : 'text-on-surface-variant hover:text-accent font-medium'
                    }`}
                  >
                    <Icon name="dark_mode" size={14} />
                    {t('appearanceSettings.themeDark')}
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between">
                <p className="font-semibold text-accent">{t('appearanceSettings.zoom')}</p>
                <div className="flex bg-surface-container-high dark:bg-surface-container-highest p-1 rounded-full">
                  {ZOOM_LEVELS.map((level) => {
                    const active = isSameZoom(zoom, level.factor)
                    return (
                      <button
                        key={level.key}
                        onClick={() => setZoom(level.factor)}
                        aria-label={t(level.labelKey)}
                        aria-pressed={active}
                        className={`flex items-center px-4 py-2 rounded-full text-sm transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${
                          active ? 'bg-surface-container-lowest shadow-sm text-accent font-semibold' : 'text-on-surface-variant hover:text-accent font-medium'
                        }`}
                      >
                        {t(level.labelKey)}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </section>

          {showMenuBarToggle && (
            <section>
              <SectionHeading>{t('appearanceSettings.menuBar')}</SectionHeading>
              <div className="bg-surface-container-low rounded-xl overflow-hidden">
                <Toggle
                  label={t('appearanceSettings.menuBarAutoHide')}
                  description={t('appearanceSettings.menuBarAutoHideDesc')}
                  checked={prefs?.appMenuAutoHide ?? false}
                  disabled={!prefs}
                  onChange={(v) => updatePrefs({ appMenuAutoHide: v })}
                />
              </div>
            </section>
          )}

          <section>
            <SectionHeading>{t('appearanceSettings.language')}</SectionHeading>
            <div className="bg-surface-container-low rounded-xl overflow-hidden">
              {SUPPORTED_LANGUAGES.map((lang) => {
                const selected = lang.code === currentLang
                return (
                  <button
                    key={lang.code}
                    type="button"
                    onClick={() => setLocale(lang.code as SupportedLanguage)}
                    aria-pressed={selected}
                    className={`w-full p-6 flex items-center justify-between transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-secondary/30 ${
                      selected ? 'bg-surface-container-high/60' : 'hover:bg-surface-container-high/50'
                    }`}
                  >
                    <span className="font-semibold text-accent">{lang.nativeLabel}</span>
                    {selected && <Icon name="check" className="text-secondary" />}
                  </button>
                )
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
