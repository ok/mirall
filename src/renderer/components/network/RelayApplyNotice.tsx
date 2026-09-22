// The relay change that has not reached the live connections, and the one act that applies it.
import { useTranslation } from 'react-i18next'
import Button from '../primitives/Button.js'
import type { RelayApplyNotice as Notice } from '../../model/relay-apply.js'

interface RelayApplyNoticeProps {
  notice: Notice
  busy: boolean
  onAct: () => void
}

export default function RelayApplyNotice({ notice, busy, onAct }: RelayApplyNoticeProps) {
  const { t } = useTranslation()
  const action = notice === 'restart' ? 'reconnectAction' : 'applyAction'
  return (
    <div role="status" className="mb-4 rounded-xl bg-warning-container px-5 py-4 flex items-center gap-4">
      <p className="min-w-0 flex-1 text-sm text-on-warning-container leading-relaxed">
        {t(`networkSettings.relays.notice.${notice}`)}
      </p>
      <Button variant="secondary" ariaDisabled={busy} onClick={() => { if (!busy) onAct() }}>
        {t(`networkSettings.relays.${busy ? 'applying' : action}`)}
      </Button>
    </div>
  )
}
