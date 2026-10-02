// The backup's dialogs, opened one at a time by whichever screen offers them. "Forgot it?" in the
// passphrase check hands over to making a new key.
import BackupSetupModal from '../modals/BackupSetupModal.js'
import CheckKeyModal from '../modals/CheckKeyModal.js'
import NewKeyModal from '../modals/NewKeyModal.js'

export type BackupDialog = 'setup' | 'check' | 'new-key' | null

interface BackupDialogsProps {
  open: BackupDialog
  onChange: (dialog: BackupDialog) => void
}

export default function BackupDialogs({ open, onChange }: BackupDialogsProps) {
  return (
    <>
      <BackupSetupModal isOpen={open === 'setup'} onClose={() => onChange(null)} />
      <CheckKeyModal isOpen={open === 'check'} onClose={() => onChange(null)} onForgot={() => onChange('new-key')} />
      <NewKeyModal isOpen={open === 'new-key'} onClose={() => onChange(null)} />
    </>
  )
}
