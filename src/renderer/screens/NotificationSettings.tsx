// Notification settings: master/sound/focus-suppression toggles and per-event enablement.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import Icon from '../components/primitives/Icon.js'
import PageHeader from '../components/layout/PageHeader.js'
import SectionHeading from '../components/layout/SectionHeading.js'
import Toggle from '../components/primitives/Toggle.js'
import {
  getPrefs,
  setPrefs,
  type NotificationPrefs,
  type NotificationEventPrefs,
} from '../notifications/prefs.js'

interface NotificationSettingsProps {
  onBack: () => void
}

export default function NotificationSettings({ onBack }: NotificationSettingsProps) {
  const { t } = useTranslation()
  const [prefs, setLocalPrefs] = useState<NotificationPrefs>(() => getPrefs())
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()

  function update(next: NotificationPrefs) {
    setLocalPrefs(next)
    setPrefs(next)
  }

  function setMaster<K extends 'enabled' | 'sound' | 'suppressWhenFocused'>(key: K, value: boolean) {
    update({ ...prefs, [key]: value })
  }

  function setEvent<K extends keyof NotificationEventPrefs>(key: K, value: boolean) {
    update({ ...prefs, events: { ...prefs.events, [key]: value } })
  }

  const eventsDisabled = !prefs.enabled
  const eventRows: Array<{ key: keyof NotificationEventPrefs; label: string; desc: string }> = [
    { key: 'memberJoined', label: t('notificationSettings.eventMemberJoined'), desc: t('notificationSettings.eventMemberJoinedDesc') },
    { key: 'memberLeft', label: t('notificationSettings.eventMemberLeft'), desc: t('notificationSettings.eventMemberLeftDesc') },
    { key: 'transferComplete', label: t('notificationSettings.eventTransferComplete'), desc: t('notificationSettings.eventTransferCompleteDesc') },
    { key: 'transferError', label: t('notificationSettings.eventTransferError'), desc: t('notificationSettings.eventTransferErrorDesc') },
    { key: 'transferPaused', label: t('notificationSettings.eventTransferPaused'), desc: t('notificationSettings.eventTransferPausedDesc') },
  ]

  return (
    <div
      ref={ref}
      className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader
          title={t('notificationSettings.title')}
          subtitle={t('notificationSettings.intro')}
          onBack={onBack}
        />

        <div className="space-y-10">
          <section>
            <SectionHeading>{t('notificationSettings.general')}</SectionHeading>
            <div className="bg-surface-container-low rounded-xl overflow-hidden">
              <Toggle
                label={t('notificationSettings.master')}
                description={t('notificationSettings.masterDesc')}
                checked={prefs.enabled}
                onChange={(v) => setMaster('enabled', v)}
              />
              <Toggle
                label={t('notificationSettings.sound')}
                description={t('notificationSettings.soundDesc')}
                checked={prefs.sound}
                disabled={eventsDisabled}
                onChange={(v) => setMaster('sound', v)}
              />
              <Toggle
                label={t('notificationSettings.suppressWhenFocused')}
                description={t('notificationSettings.suppressWhenFocusedDesc')}
                checked={prefs.suppressWhenFocused}
                disabled={eventsDisabled}
                onChange={(v) => setMaster('suppressWhenFocused', v)}
              />
            </div>
          </section>

          <section>
            <SectionHeading>{t('notificationSettings.events')}</SectionHeading>
            <div className="bg-surface-container-low rounded-xl overflow-hidden">
              {eventRows.map((row) => (
                <Toggle
                  key={row.key}
                  label={row.label}
                  description={row.desc}
                  checked={prefs.events[row.key]}
                  disabled={eventsDisabled}
                  onChange={(v) => setEvent(row.key, v)}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
