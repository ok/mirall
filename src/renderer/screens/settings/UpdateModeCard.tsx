// General's update-mode card: how much of an update runs without the user, and what the chosen mode
// means. The sentence under the control describes every segment, so the consequence of a choice is
// read where it is made. On a copy that does not update itself the control is locked, no mode reads
// as chosen, and the sentence says why.
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UPDATE_MODES, UPDATE_STATE, UPDATES_OFF_REASON, type UpdateMode, type UpdateStatus } from '../../../shared/contract/update-status.js'
import { useRunAction } from '../../hooks/useRunAction.js'
import SegmentedControl, { Segment } from '../../components/primitives/SegmentedControl.js'

interface UpdateModeCardProps {
  status: UpdateStatus
  onChange: (mode: UpdateMode) => Promise<void>
}

export default function UpdateModeCard({ status, onChange }: UpdateModeCardProps) {
  const { t } = useTranslation()
  const descId = useId()
  const runAction = useRunAction()
  const [pending, setPending] = useState<UpdateMode | null>(null)
  const off = status.state === UPDATE_STATE.OFF
  const shown = pending ?? status.mode
  const descKey = !off ? `${shown}Desc` : status.offReason === UPDATES_OFF_REASON.DEB_INSTALL ? 'offDebDesc' : 'offDesc'

  function select(next: UpdateMode) {
    if (pending || next === status.mode) return
    setPending(next)
    runAction(async () => {
      try {
        await onChange(next)
      } finally {
        setPending(null)
      }
    })
  }

  return (
    <div className="bg-surface-container-low rounded-xl p-6">
      <div className="flex items-center justify-between gap-4">
        <p className="font-semibold text-accent">{t('generalSettings.updateMode.label')}</p>
        <SegmentedControl className="shrink-0">
          {UPDATE_MODES.map((m) => (
            <Segment
              key={m}
              label={t(`generalSettings.updateMode.${m}`)}
              selected={!off && shown === m}
              busy={pending !== null}
              locked={off}
              describedBy={descId}
              onSelect={() => select(m)}
            />
          ))}
        </SegmentedControl>
      </div>
      <p id={descId} className="text-sm text-on-surface-variant mt-2">{t(`generalSettings.updateMode.${descKey}`)}</p>
    </div>
  )
}
