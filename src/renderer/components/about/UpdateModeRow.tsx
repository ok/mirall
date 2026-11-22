// About's update-mode row: how much of an update runs without the user, and what the chosen mode
// means. The sentence under the control describes every segment, so the consequence of a choice is
// read where it is made.
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UPDATE_MODES, type UpdateMode } from '../../../shared/contract/update-status.js'
import { useRunAction } from '../../hooks/useRunAction.js'
import SegmentedControl, { Segment } from '../primitives/SegmentedControl.js'

interface UpdateModeRowProps {
  mode: UpdateMode
  onChange: (mode: UpdateMode) => Promise<void>
}

export default function UpdateModeRow({ mode, onChange }: UpdateModeRowProps) {
  const { t } = useTranslation()
  const descId = useId()
  const runAction = useRunAction()
  const [pending, setPending] = useState<UpdateMode | null>(null)
  const shown = pending ?? mode

  function select(next: UpdateMode) {
    if (pending || next === mode) return
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
    <div className="bg-surface-container-low rounded-xl p-6 mt-3">
      <div className="flex items-center justify-between gap-4">
        <p className="font-semibold text-accent">{t('about.mode.label')}</p>
        <SegmentedControl className="shrink-0">
          {UPDATE_MODES.map((m) => (
            <Segment
              key={m}
              label={t(`about.mode.${m}`)}
              selected={shown === m}
              busy={pending !== null}
              describedBy={descId}
              onSelect={() => select(m)}
            />
          ))}
        </SegmentedControl>
      </div>
      <p id={descId} className="text-sm text-on-surface-variant mt-2">{t(`about.mode.${shown}Desc`)}</p>
    </div>
  )
}
