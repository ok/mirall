// The first question of a restore: from a backup folder (everything comes back) or from a recovery key
// file alone (the identity comes back, and the spaces return from the people who share them).
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../primitives/Modal.js'
import ModalHeader from '../primitives/ModalHeader.js'
import ModalFooter from '../layout/ModalFooter.js'
import Button from '../primitives/Button.js'
import Icon from '../primitives/Icon.js'
import RadioCard from '../primitives/RadioCard.js'

export type RestoreSource = 'backup' | 'key'

interface RestoreAccountModalProps {
  isOpen: boolean
  onClose: () => void
  onChoose: (source: RestoreSource) => void
}

const OPTIONS = [
  { source: 'backup', icon: 'folder_open', title: 'restoreAccount.fromBackup', body: 'restoreAccount.fromBackupBody' },
  { source: 'key', icon: 'description', title: 'restoreAccount.fromKey', body: 'restoreAccount.fromKeyBody' },
] as const

export default function RestoreAccountModal({ isOpen, onClose, onChoose }: RestoreAccountModalProps) {
  const { t } = useTranslation()
  const [source, setSource] = useState<RestoreSource>('backup')
  const title = t('restoreAccount.title')

  return (
    <Modal isOpen={isOpen} onClose={onClose} onConfirm={() => onChoose(source)} ariaLabel={title}>
      <>
        <ModalHeader title={title} description={t('restoreAccount.intro')} descriptionSize="sm" onClose={onClose} />
        <div className="px-10 pb-10 space-y-6">
          <div role="radiogroup" aria-label={t('restoreAccount.listLabel')} className="space-y-3">
            {OPTIONS.map((option) => (
              <RadioCard
                key={option.source}
                name="restore-account-source"
                checked={source === option.source}
                onSelect={() => setSource(option.source)}
                labelledBy={`restore-source-${option.source}-title`}
                describedBy={`restore-source-${option.source}-body`}
              >
                <span className="w-10 h-10 rounded-full bg-icon-tile flex items-center justify-center text-on-icon-tile shrink-0">
                  <Icon name={option.icon} />
                </span>
                <span className="min-w-0">
                  <span id={`restore-source-${option.source}-title`} className="block font-headline font-bold text-accent">{t(option.title)}</span>
                  <span id={`restore-source-${option.source}-body`} className="block text-sm text-on-surface-variant mt-1">{t(option.body)}</span>
                </span>
              </RadioCard>
            ))}
          </div>
          <ModalFooter layout="split">
            <Button variant="secondary" size="lg" onClick={onClose}>{t('actions.cancel')}</Button>
            <Button size="lg" icon="arrow_forward" onClick={() => onChoose(source)}>{t('backupSetup.next')}</Button>
          </ModalFooter>
        </div>
      </>
    </Modal>
  )
}
