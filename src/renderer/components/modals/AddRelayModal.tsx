import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isWellFormedRelayKey } from '../../relay-key.js'
import Modal from '../primitives/Modal.js'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import Button from '../primitives/Button.js'

interface AddRelayModalProps {
  isOpen: boolean
  onClose: () => void
  onAdd: (publicKey: string, label: string) => void
}

export default function AddRelayModal({ isOpen, onClose, onAdd }: AddRelayModalProps) {
  const { t } = useTranslation()
  const [publicKey, setPublicKey] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)

  function handleClose() {
    setPublicKey('')
    setLabel('')
    setError(null)
    onClose()
  }

  function handleAdd() {
    const key = publicKey.trim()
    if (!key) return
    if (!isWellFormedRelayKey(key)) {
      setError(t('networkSettings.relays.invalidKey'))
      return
    }
    onAdd(key, label.trim())
    handleClose()
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      onConfirm={handleAdd}
      ariaLabel={t('networkSettings.relays.addTitle')}
      panelClassName="glass-modal w-full max-w-md rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative"
    >
      <>
        <div className="px-10 pt-10 pb-6">
          <div className="flex justify-between items-start mb-2">
            <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight">
              {t('networkSettings.relays.addTitle')}
            </h1>
            <IconButton icon="close" onClick={handleClose} ariaLabel={t('actions.close')} iconClassName="text-secondary" />
          </div>
          <p className="text-on-surface-variant font-medium text-sm">{t('networkSettings.relays.addDesc')}</p>
        </div>
        <div className="px-10 pb-10 space-y-6">
          <div className="space-y-3">
            <label htmlFor="add-relay-key" className="font-headline text-sm font-bold text-accent px-1">
              {t('networkSettings.relays.keyLabel')}
            </label>
            <input
              id="add-relay-key"
              autoFocus
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'add-relay-error' : undefined}
              className="w-full bg-surface-container-low border-none focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 rounded-xl px-6 py-4 text-accent font-medium placeholder:text-outline/50 transition-all font-mono text-sm"
              placeholder={t('networkSettings.relays.keyPlaceholder')}
              value={publicKey}
              onChange={(e) => { setPublicKey(e.target.value); setError(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) handleAdd() }}
            />
          </div>
          <div className="space-y-3">
            <label htmlFor="add-relay-label" className="font-headline text-sm font-bold text-accent px-1">
              {t('networkSettings.relays.labelLabel')}
            </label>
            <input
              id="add-relay-label"
              className="w-full bg-surface-container-low border-none focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 rounded-xl px-6 py-4 text-accent font-medium placeholder:text-outline/50 transition-all"
              placeholder={t('networkSettings.relays.labelPlaceholder')}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) handleAdd() }}
            />
          </div>
          {error && (
            <div id="add-relay-error" className="rounded-xl bg-error-container/60 px-5 py-3 text-sm font-medium text-on-error-container" role="alert">
              {error}
            </div>
          )}
          <Button size="lg" fullWidth onClick={handleAdd} disabled={!publicKey.trim()}>
            {t('networkSettings.relays.addAction')}
            <Icon name="add_circle" />
          </Button>
        </div>
      </>
    </Modal>
  )
}
