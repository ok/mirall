// Confirm-then-progress dialog for leaving a space; tracks the worker's
// leave-progress events while local data is cleaned up and compacted.
import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { subscribe } from '../../ipc.js'
import { formatSize } from '../../utils.js'
import Modal from '../primitives/Modal.js'
import IconButton from '../primitives/IconButton.js'
import Button from '../primitives/Button.js'
import FilenameTitle from '../widgets/FilenameTitle.js'

interface LeaveSpaceModalProps {
  isOpen: boolean
  spaceName: string
  spaceId: string
  onClose: () => void
  onLeave: () => Promise<void>
  onComplete: () => void
}

interface LeaveProgress {
  step: number
  totalSteps: number
  phase: string
  data?: Record<string, string>
}

const PROGRESS_CAP = 50
const COMPLETION_HOLD_MS = 350

const PHASES_WITH_SIZE = new Set(['compactingPeerCache', 'compactingLocalCache'])

export default function LeaveSpaceModal({ isOpen, spaceName, spaceId, onClose, onLeave, onComplete }: LeaveSpaceModalProps) {
  const { t } = useTranslation()
  const [leaving, setLeaving] = useState(false)
  const [done, setDone] = useState(false)
  const [progress, setProgress] = useState<LeaveProgress | null>(null)
  const totalBytesRef = useRef<number>(0)

  useEffect(() => {
    if (isOpen && spaceId) {
      setLeaving(false)
      setDone(false)
      setProgress(null)
      totalBytesRef.current = 0
    }
  }, [isOpen, spaceId])

  useEffect(() => {
    if (!leaving) return
    const unsub = subscribe('event:leave-progress', (msg) => {
      if (msg.spaceId !== spaceId) return
      if (typeof msg.totalBytes === 'number') {
        totalBytesRef.current = msg.totalBytes
      }
      setProgress({
        step: msg.step as number,
        totalSteps: msg.totalSteps as number,
        phase: msg.phase as string,
        data: (msg.data as Record<string, string> | undefined),
      })
    })
    return unsub
  }, [leaving, spaceId])

  async function handleLeave() {
    if (leaving) return
    setLeaving(true)
    try {
      await onLeave()
    } finally {
      setDone(true)
      setTimeout(() => { onComplete() }, COMPLETION_HOLD_MS)
    }
  }

  const computedPercent = progress
    ? Math.min(PROGRESS_CAP, Math.round((progress.step / progress.totalSteps) * PROGRESS_CAP))
    : 0
  const percent = done ? 100 : computedPercent
  const showStripe = leaving && !done && computedPercent >= PROGRESS_CAP

  function renderLabel(): string {
    if (!progress) return t('leaveSpace.preparing')
    const phaseKey = `leaveSpace.phases.${progress.phase}`
    const useSize = PHASES_WITH_SIZE.has(progress.phase) && totalBytesRef.current > 0
    if (useSize) {
      const sizeKey = `${phaseKey}_withSize`
      return t(sizeKey, { size: formatSize(totalBytesRef.current), defaultValue: t(phaseKey) })
    }
    const interp = (progress.data && typeof progress.data === 'object') ? progress.data : {}
    return t(phaseKey, { ...interp, defaultValue: t('leaveSpace.preparing') })
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} isDismissable={!leaving} ariaLabel={leaving ? t('leaveSpace.titleProgress') : t('leaveSpace.titleConfirm', { name: spaceName })}>
      <>
        <div className="px-10 pt-10 pb-6">
          <div className="flex justify-between items-start mb-2 gap-3">
            {leaving ? (
              <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight">
                {t('leaveSpace.titleProgress')}
              </h1>
            ) : (
              <FilenameTitle i18nKey="leaveSpace.titleConfirm" name={spaceName} />
            )}
            {!leaving && (
              <IconButton
                icon="close"
                onClick={onClose}
                ariaLabel={t('actions.close')}
                iconClassName="text-secondary"
              />
            )}
          </div>
        </div>

        <div className="px-10 pb-10 space-y-6">
          {leaving ? (
            <div className="space-y-3">
              <div
                role="progressbar"
                aria-label={t('leaveSpace.titleProgress')}
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                className="relative h-2 bg-surface-container-highest rounded-full overflow-hidden"
              >
                {showStripe && <div className="absolute inset-0 leave-progress-stripe" />}
                <div
                  className="relative h-full bg-on-info rounded-full transition-all duration-300"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p role="status" aria-live="polite" className="text-sm text-on-surface-variant font-medium">
                {renderLabel()}
              </p>
            </div>
          ) : (
            <>
              <p className="text-on-surface-variant font-medium">
                {t('leaveSpace.body')}
              </p>

              <div className="pt-4 flex gap-4">
                <Button
                  variant="secondary"
                  onClick={onClose}
                  className="flex-1 h-14"
                >
                  {t('actions.cancel')}
                </Button>
                <Button
                  variant="danger"
                  onClick={handleLeave}
                  disabled={leaving}
                  className="flex-1 h-14"
                >
                  {t('leaveSpace.leaveAction')}
                </Button>
              </div>
            </>
          )}
        </div>
      </>
    </Modal>
  )
}
