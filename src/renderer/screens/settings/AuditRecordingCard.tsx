import { useTranslation } from 'react-i18next'
import SectionHeading from '../../components/layout/SectionHeading.js'
import SegmentedControl, { Segment } from '../../components/primitives/SegmentedControl.js'
import { ToggleSwitch } from '../../components/primitives/Toggle.js'
import { RETENTION_CHOICES } from '../../../shared/contract/limits.js'
import type { AuditConfig } from '../../types/types.js'
import ManagedNote from '../../components/managed/ManagedNote.js'
import { useManagedSetting } from '../../hooks/useManagedSetting.js'

interface AuditRecordingCardProps {
  /** Null until audit:get-config answers — every read below falls back rather than guessing on. */
  config: AuditConfig | null | undefined
  onPatch: (next: Partial<AuditConfig>) => void
  /** A change is in flight: the controls read as unavailable and keep focus. */
  patching: boolean
}

/**
 * Whether activity is recorded at all, and for how long it is kept.
 *
 * The switch button is written out rather than taken from Toggle because this row is a label beside
 * a small control, not a full-width button: Toggle makes the whole row one click target, which would
 * put the retention segments inside it. The paint is Toggle's ToggleSwitch.
 */
export default function AuditRecordingCard({ config, onPatch, patching }: AuditRecordingCardProps) {
  const { t } = useTranslation()
  const recording = useManagedSetting('audit.enabled')
  const retention = useManagedSetting('audit.retentionDays')
  return (
    <section>
      <SectionHeading>{t('activityLogSettings.recording')}</SectionHeading>
      <div className="bg-surface-container-low row-group">
        <div className="w-full p-6 flex items-center justify-between hover:bg-surface-container-high/50 transition-colors">
          <div className="pr-6">
            <p className="font-semibold text-accent">{t('activityLogSettings.recordActivity')}</p>
            <p className="text-xs text-on-surface-variant mt-0.5">{t('activityLogSettings.recordActivityDesc')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={config?.enabled ?? false}
            aria-label={t('activityLogSettings.recordActivity')}
            aria-disabled={patching || recording.locked || undefined}
            aria-describedby={recording.locked ? recording.noteId : undefined}
            onClick={recording.locked ? undefined : () => onPatch({ enabled: !(config?.enabled ?? false) })}
            className="shrink-0 flex rounded-full focus-ring aria-disabled:opacity-50"
          >
            <ToggleSwitch checked={config?.enabled ?? false} />
          </button>
        </div>
        {recording.org && <ManagedNote id={recording.noteId} org={recording.org} className="px-6 pb-5 -mt-2" />}

        <div className="px-6 py-5 border-t border-outline-variant/40 flex items-center justify-between gap-4">
          <div>
            <p className="font-semibold text-accent">{t('activityLogSettings.retention')}</p>
            <p className="text-xs text-on-surface-variant mt-0.5">{t('activityLogSettings.retentionDesc')}</p>
          </div>
          <SegmentedControl className="shrink-0">
            {RETENTION_CHOICES.map((days) => (
              <Segment
                key={days}
                label={t('activityLogSettings.retentionDays', { count: days })}
                selected={config?.retentionDays === days}
                onSelect={() => onPatch({ retentionDays: days })}
                busy={patching}
                locked={retention.locked}
                describedBy={retention.locked ? retention.noteId : undefined}
              />
            ))}
          </SegmentedControl>
        </div>
        {retention.org && <ManagedNote id={retention.noteId} org={retention.org} className="px-6 pb-5 -mt-2" />}
      </div>
    </section>
  )
}
