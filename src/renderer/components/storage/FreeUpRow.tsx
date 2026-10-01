// The "Free up" row: what can be freed and the button, then each step as it runs, then the result.
// The status line is a polite live region, so the start, every step and the result are announced.
import { useTranslation } from 'react-i18next'
import Button from '../primitives/Button.js'
import ProgressBar from '../primitives/ProgressBar.js'
import { formatSize } from '../../format/utils.js'
import type { FreeUpOutcome, FreeUpPhase } from '../../hooks/useFreeUpSpace.js'

// How far along the bar is at each running step; the steps have no measurable progress of their own.
const PHASE_PROGRESS: Record<Exclude<FreeUpPhase, 'idle' | 'done'>, number> = {
  updates: 10,
  records: 35,
  restarting: 60,
  measuring: 85,
}

interface FreeUpRowProps {
  reclaimable: number
  phase: FreeUpPhase
  outcome: FreeUpOutcome | null
  onStart: () => void
}

export default function FreeUpRow({ reclaimable, phase, outcome, onStart }: FreeUpRowProps) {
  const { t } = useTranslation()
  const phaseText = {
    updates: t('storageSettings.freeUp.phase.updates'),
    records: t('storageSettings.freeUp.phase.records'),
    restarting: t('storageSettings.freeUp.phase.restarting'),
    measuring: t('storageSettings.freeUp.phase.measuring'),
  }
  const running = phase !== 'idle' && phase !== 'done'
  return (
    <div className="px-6 py-5 border-t border-outline-variant/40">
      <div className="flex items-center justify-between gap-4">
        <div role="status" aria-live="polite" className="min-w-0">
          {phase === 'done' && outcome ? (
            <>
              <p className="text-sm font-semibold text-on-surface-variant">{t('storageSettings.freeUp.done', { size: formatSize(outcome.freed) })}</p>
              <p className="text-xs text-on-surface-variant">{t('storageSettings.freeUp.doneDesc', { total: formatSize(outcome.total) })}</p>
            </>
          ) : running ? (
            <>
              <p className="text-sm font-semibold text-on-surface-variant">{t('storageSettings.freeUp.running')}</p>
              <p className="text-xs text-on-surface-variant">{phaseText[phase]}</p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-on-surface-variant">{t('storageSettings.freeUp.title', { size: formatSize(reclaimable) })}</p>
              <p id="storage-free-up-desc" className="text-xs text-on-surface-variant">{t('storageSettings.freeUp.desc')}</p>
            </>
          )}
        </div>
        {phase === 'idle' && (
          <Button variant="secondary" size="sm" onClick={onStart} ariaDescribedBy="storage-free-up-desc">
            {t('storageSettings.freeUp.button', { size: formatSize(reclaimable) })}
          </Button>
        )}
      </div>
      {running && <ProgressBar value={PHASE_PROGRESS[phase]} label={t('storageSettings.freeUp.running')} />}
    </div>
  )
}
