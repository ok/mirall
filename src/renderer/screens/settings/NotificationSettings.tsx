// Notification settings: master/sound/focus-suppression toggles and per-event enablement, grouped by whom the event is about.
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useHasVerticalOverflow } from '../../hooks/useHasVerticalOverflow.js'
import { useRunAction } from '../../hooks/useRunAction.js'
import PageHeader from '../../components/layout/PageHeader.js'
import SectionHeading from '../../components/layout/SectionHeading.js'
import Toggle from '../../components/primitives/Toggle.js'
import { getPrefs, setPrefs } from '../../notifications/prefs.js'
import type { NotificationPrefs, NotificationEventPrefs } from '../../notifications/prefs-shape.js'

interface EventRow {
  key: keyof NotificationEventPrefs
  label: string
  desc: string
}

interface NotificationSettingsProps {
  onBack: () => void
}

export default function NotificationSettings({ onBack }: NotificationSettingsProps) {
  const { t } = useTranslation()
  const [prefs, setLocalPrefs] = useState<NotificationPrefs>(() => getPrefs())
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const runAction = useRunAction()
  const writeSeq = useRef(0)

  // A refused write shows what main actually holds again. Only the latest write owns the outcome.
  function update(next: NotificationPrefs) {
    const mine = ++writeSeq.current
    setLocalPrefs(next)
    runAction(async () => {
      try {
        await setPrefs(next)
      } catch (err) {
        if (mine !== writeSeq.current) return
        setLocalPrefs(getPrefs())
        throw err
      }
    })
  }

  function setMaster<K extends 'enabled' | 'sound' | 'suppressWhenFocused'>(key: K, value: boolean) {
    update({ ...prefs, [key]: value })
  }

  function setEvent<K extends keyof NotificationEventPrefs>(key: K, value: boolean) {
    update({ ...prefs, events: { ...prefs.events, [key]: value } })
  }

  const eventsDisabled = !prefs.enabled
  const eventSections: Array<{ title: string; rows: EventRow[] }> = [
    {
      title: t('notificationSettings.sectionPeople'),
      rows: [
        { key: 'joinRequests', label: t('notificationSettings.eventJoinRequests'), desc: t('notificationSettings.eventJoinRequestsDesc') },
        { key: 'presence', label: t('notificationSettings.eventPresence'), desc: t('notificationSettings.eventPresenceDesc') },
      ],
    },
    {
      title: t('notificationSettings.sectionSharedWithYou'),
      rows: [{ key: 'newShares', label: t('notificationSettings.eventNewShares'), desc: t('notificationSettings.eventNewSharesDesc') }],
    },
    {
      title: t('notificationSettings.sectionYourShares'),
      rows: [{ key: 'fileReceived', label: t('notificationSettings.eventFileReceived'), desc: t('notificationSettings.eventFileReceivedDesc') }],
    },
    {
      title: t('notificationSettings.sectionYourDownloads'),
      rows: [
        { key: 'transferComplete', label: t('notificationSettings.eventTransferComplete'), desc: t('notificationSettings.eventTransferCompleteDesc') },
        { key: 'transferError', label: t('notificationSettings.eventTransferError'), desc: t('notificationSettings.eventTransferErrorDesc') },
        { key: 'transferPaused', label: t('notificationSettings.eventTransferPaused'), desc: t('notificationSettings.eventTransferPausedDesc') },
      ],
    },
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

          {eventSections.map((section) => (
            <section key={section.title}>
              <SectionHeading>{section.title}</SectionHeading>
              <div className="bg-surface-container-low rounded-xl overflow-hidden">
                {section.rows.map((r) => (
                  <Toggle
                    key={r.key}
                    label={r.label}
                    description={r.desc}
                    checked={prefs.events[r.key]}
                    disabled={eventsDisabled}
                    onChange={(v) => setEvent(r.key, v)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
