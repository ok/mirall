// Appearance settings: theme (light/dark/system), language, and UI zoom.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n, { setLocale, SUPPORTED_LANGUAGES, type SupportedLanguage } from '../i18n.js'
import { applyTheme, getStoredTheme, type ThemeMode } from '../theme.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useMainQuery } from '../store/useMainQuery.js'
import { useZoom, ZOOM_LEVELS, nearestZoomLevel } from '../hooks/useZoom.js'
import Icon, { type IconName } from '../components/primitives/Icon.js'
import PageHeader from '../components/layout/PageHeader.js'
import SectionHeading from '../components/layout/SectionHeading.js'
import SegmentedControl, { Segment } from '../components/primitives/SegmentedControl.js'
import Toggle from '../components/primitives/Toggle.js'

// The three theme choices as data, so the selector reads as one map like the zoom row beside it.
const THEME_MODES: Array<{ mode: ThemeMode; icon: IconName; labelKey: string }> = [
  { mode: 'light', icon: 'light_mode', labelKey: 'appearanceSettings.themeLight' },
  { mode: 'system', icon: 'computer', labelKey: 'appearanceSettings.themeSystem' },
  { mode: 'dark', icon: 'dark_mode', labelKey: 'appearanceSettings.themeDark' },
]

interface AppearanceSettingsProps {
  onBack: () => void
}

export default function AppearanceSettings({ onBack }: AppearanceSettingsProps) {
  const { t } = useTranslation()
  const [theme, setTheme] = useState<ThemeMode>(() => getStoredTheme())
  const { zoom, setZoom } = useZoom()
  const selectedZoomKey = nearestZoomLevel(zoom).key
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const currentLang = i18n.language
  const showMenuBarToggle = window.bridge.getPlatform() !== 'darwin'
  // macOS has no menu-bar toggle, and prefs are read here for nothing else — so this screen does
  // not pull them there. Everywhere else it shares the one copy with GeneralSettings.
  const { data: prefs, patch: updatePrefs } = useMainQuery('main:prefs', { enabled: showMenuBarToggle })

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
                <SegmentedControl>
                  {THEME_MODES.map((m) => (
                    <Segment
                      key={m.mode}
                      icon={m.icon}
                      label={t(m.labelKey)}
                      selected={theme === m.mode}
                      onSelect={() => handleTheme(m.mode)}
                    />
                  ))}
                </SegmentedControl>
              </div>
              <div className="flex items-center justify-between">
                <p className="font-semibold text-accent">{t('appearanceSettings.zoom')}</p>
                <SegmentedControl>
                  {ZOOM_LEVELS.map((level) => (
                    <Segment
                      key={level.key}
                      label={t(level.labelKey)}
                      selected={level.key === selectedZoomKey}
                      onSelect={() => setZoom(level.factor)}
                    />
                  ))}
                </SegmentedControl>
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
