// Restoring an account from onboarding or the locked screen, behind one entry. With the local backup on,
// the user first says what they have — a backup folder or only a key file — and that dialog follows;
// without it, the key dialog opens directly.
import { useState } from 'react'
import { isLocalBackupFeatureOn } from '../../platform/config-client.js'
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
  const choosing = isOpen && isLocalBackupFeatureOn() && source === null
  const shown: RestoreSource | null = !isOpen ? null : isLocalBackupFeatureOn() ? source : 'key'

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
