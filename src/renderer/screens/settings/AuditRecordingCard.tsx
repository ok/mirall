import { useTranslation } from 'react-i18next'
import SectionHeading from '../../components/layout/SectionHeading.js'
import SegmentedControl, { Segment } from '../../components/primitives/SegmentedControl.js'
import { RETENTION_CHOICES } from '../../../shared/contract/limits.js'
import type { AuditConfig } from '../../types/types.js'

interface AuditRecordingCardProps {
  /** Null until audit:get-config answers — every read below falls back rather than guessing on. */
  config: AuditConfig | null | undefined
  onPatch: (next: Partial<AuditConfig>) => Promise<void>
}

/**
 * Whether activity is recorded at all, and for how long it is kept.
 *
 * The switch is written out rather than taken from Toggle because this row is a label beside a
 * small control, not a full-width button: Toggle makes the whole row one click target, which would
 * put the retention segments inside it.
 */
export default function AuditRecordingCard({ config, onPatch }: AuditRecordingCardProps) {
  const { t } = useTranslation()
  return (
    <section>
      <SectionHeading>{t('activityLogSettings.recording')}</SectionHeading>
      <div className="bg-surface-container-low rounded-xl overflow-hidden">
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
            onClick={() => void onPatch({ enabled: !(config?.enabled ?? false) })}
            className={`relative shrink-0 w-12 h-7 rounded-full transition-colors focus-ring ${
              config?.enabled ? 'bg-primary' : 'bg-surface-container-high'
            }`}
          >
            <span
              className={`absolute top-1 left-1 w-5 h-5 rounded-full bg-surface-container-lowest transition-transform ${
                config?.enabled ? 'translate-x-5' : ''
              }`}
            />
          </button>
        </div>

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
                onSelect={() => void onPatch({ retentionDays: days })}
              />
            ))}
          </SegmentedControl>
        </div>
      </div>
    </section>
  )
}
