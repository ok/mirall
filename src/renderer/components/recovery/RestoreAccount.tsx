// Restoring an account from onboarding or the locked screen, behind one entry: the user first says what
// they have — a backup folder or only a key file — and that dialog follows.
import { useState } from 'react'
import RestoreAccountModal, { type RestoreSource } from '../modals/RestoreAccountModal.js'
import RecoveryRestoreModal from '../modals/RecoveryRestoreModal.js'
import RestoreBackupModal from '../modals/RestoreBackupModal.js'

interface RestoreAccountProps {
  isOpen: boolean
  onClose: () => void
  onRestored: () => Promise<void>
}

export default function RestoreAccount({ isOpen, onClose, onRestored }: RestoreAccountProps) {
  const [source, setSource] = useState<RestoreSource | null>(null)
  const choosing = isOpen && source === null
  const shown: RestoreSource | null = isOpen ? source : null

  function close() {
    setSource(null)
    onClose()
  }

  return (
    <>
      <RestoreAccountModal isOpen={choosing} onClose={close} onChoose={setSource} />
      <RecoveryRestoreModal isOpen={shown === 'key'} onClose={close} onRestored={onRestored} />
      <RestoreBackupModal isOpen={shown === 'backup'} onClose={close} onRestored={onRestored} />
    </>
  )
}
