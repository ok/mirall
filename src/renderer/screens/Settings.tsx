// Settings hub: tile navigation into the general / appearance / notifications / storage / about subscreens.
import { useTranslation } from 'react-i18next'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import Icon, { type IconName } from '../components/primitives/Icon.js'
import PageHeader from '../components/layout/PageHeader.js'

interface SettingsProps {
  onBack: () => void
  onNavigate: (screen: string) => void
}

export default function Settings({ onBack, onNavigate }: SettingsProps) {
  const { t } = useTranslation()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const isMac = window.bridge.getPlatform() === 'darwin'
  const generalDesc = isMac ? t('settings.generalDescMac') : t('settings.generalDesc')

  const items: Array<{ icon: IconName; label: string; desc: string; bg: string; fg: string; screen: string }> = [
    { icon: 'desktop_windows', label: t('settings.general'),       desc: generalDesc,                  bg: 'bg-icon-tile', fg: 'text-on-icon-tile', screen: 'general-settings' },
    { icon: 'palette',         label: t('settings.appearance'),    desc: t('settings.appearanceDesc'), bg: 'bg-icon-tile', fg: 'text-on-icon-tile', screen: 'appearance-settings' },
    { icon: 'notifications',   label: t('settings.notifications'), desc: t('settings.notificationsDesc'), bg: 'bg-icon-tile', fg: 'text-on-icon-tile', screen: 'notification-settings' },
    { icon: 'hub',             label: t('settings.network'),       desc: t('settings.networkDesc'),    bg: 'bg-icon-tile', fg: 'text-on-icon-tile', screen: 'network-settings' },
    { icon: 'database',        label: t('settings.storage'),       desc: t('settings.storageDesc'),    bg: 'bg-icon-tile', fg: 'text-on-icon-tile', screen: 'storage-settings' },
    { icon: 'history',         label: t('settings.activityLog'),  desc: t('settings.activityLogDesc'), bg: 'bg-icon-tile', fg: 'text-on-icon-tile', screen: 'activity-log-settings' },
    { icon: 'info',            label: t('settings.about'),         desc: t('settings.aboutDesc'),      bg: 'bg-icon-tile', fg: 'text-on-icon-tile', screen: 'about' },
  ]

  return (
    <div
      ref={ref}
      className={`h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader
          title={t('settings.title')}
          subtitle={t('settings.intro')}
          onBack={onBack}
        />

        <div className="space-y-10">
          <section>
            <div className="bg-surface-container-low rounded-xl overflow-hidden">
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => onNavigate(item.screen)}
                  aria-label={item.label}
                  className="w-full text-left p-6 flex items-center justify-between hover:bg-surface-container-high/50 active:scale-[0.99] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 cursor-pointer"
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-full ${item.bg} flex items-center justify-center ${item.fg}`}>
                      <Icon name={item.icon} />
                    </div>
                    <div>
                      <p className="font-semibold text-accent">{item.label}</p>
                      <p className="text-xs text-on-surface-variant">{item.desc}</p>
                    </div>
                  </div>
                  <Icon name="chevron_right" className="text-secondary" />
                </button>
              ))}
            </div>
          </section>
        </div>

      </div>
    </div>
  )
}
