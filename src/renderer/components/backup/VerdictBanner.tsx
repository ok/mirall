// The Backup screen's verdict: a lamp, what is true right now, and the one action that helps.
import { useTranslation } from 'react-i18next'
import { formatDateTime } from '../../format/utils.js'
import type { Fix, Lamp } from '../../model/protection-view.js'
import Button from '../primitives/Button.js'

const LAMP: Record<Lamp, string> = {
  protected: 'bg-online ring-online/25',
  'at-risk': 'bg-secondary-container ring-secondary-container/30',
  stopped: 'bg-error ring-error/25',
  paused: 'bg-outline ring-outline/20',
}

const FIX_LABEL: Record<NonNullable<Fix>, string> = {
  setup: 'backup.setUp',
  check: 'backup.checkPassphrase',
  'new-key': 'backup.choosePassphrase',
  run: 'backup.runNow',
}

interface VerdictBannerProps {
  banner: { lamp: Lamp; key: string; fix: Fix }
  when: number | null
  running: boolean
  onFix: (fix: Fix) => void
}

export default function VerdictBanner({ banner, when, running, onFix }: VerdictBannerProps) {
  const { t } = useTranslation()
  const quiet = banner.lamp === 'protected'
  return (
    <section>
      <div className="bg-surface-container-low rounded-xl p-6 flex items-center gap-5">
        <span aria-hidden="true" className={`w-4 h-4 rounded-full shrink-0 ring-4 ${LAMP[banner.lamp]}`} />
        <div role="status" aria-live="polite" className="flex-1 min-w-0">
          <p className="text-2xl font-headline font-bold text-accent">{t(`protection.verdict.${banner.key}Title`)}</p>
          <p className="text-sm text-on-surface-variant mt-1">{t(`protection.verdict.${banner.key}Body`, { when: when ? formatDateTime(when) : '' })}</p>
        </div>
        {banner.fix && (
          <Button variant={quiet ? 'secondary' : 'primary'} onClick={() => onFix(banner.fix)} ariaDisabled={banner.fix === 'run' && running}>
            {t(running && banner.fix === 'run' ? 'backup.running' : FIX_LABEL[banner.fix])}
          </Button>
        )}
      </div>
    </section>
  )
}
