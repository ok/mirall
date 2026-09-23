import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useErrorText } from '../../hooks/useErrorText.js'
import { useToast } from '../toast/ToastProvider.js'
import ConfirmDestructiveModal from './ConfirmDestructiveModal.js'
import FilenameTitle from '../primitives/FilenameTitle.js'

interface LeaveSpaceModalProps {
  isOpen: boolean
  spaceName: string
  onClose: () => void
  onLeave: () => Promise<void>
  onComplete: () => void
}

export default function LeaveSpaceModal({ isOpen, spaceName, onClose, onLeave, onComplete }: LeaveSpaceModalProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const [leaving, setLeaving] = useState(false)

  // Leaving is irreversible, so navigating away runs on resolve only. A rejection reports and
  // returns the dialog to its confirm step, where the space is still joined and the leave can be
  // retried; the dialog stays busy on success because it unmounts with the navigation.
  async function handleLeave() {
    if (leaving) return
    setLeaving(true)
    try {
      await onLeave()
    } catch (err) {
      toast.error(errorText(err))
      setLeaving(false)
      return
    }
    onComplete()
  }

  return (
    <ConfirmDestructiveModal
      isOpen={isOpen}
      title={t('leaveSpace.titleConfirm', { name: spaceName })}
      titleNode={<FilenameTitle i18nKey="leaveSpace.titleConfirm" name={spaceName} />}
      body={t('leaveSpace.body')}
      confirmLabel={leaving ? t('leaveSpace.leaving') : t('leaveSpace.leaveAction')}
      busy={leaving}
      onClose={onClose}
      onConfirm={() => void handleLeave()}
    />
  )
}
