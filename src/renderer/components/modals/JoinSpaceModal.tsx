// Join-a-space form: accepts a pasted invite code or link and pre-fills the
// space name from the invite envelope.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Space } from '../../types.js'
import { decodeInvite, extractInviteCode } from '../../invite-envelope.js'
import Modal from '../primitives/Modal.js'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import Button from '../primitives/Button.js'

interface JoinSpaceModalProps {
  isOpen: boolean
  initialCode?: string
  initialName?: string
  onClose: () => void
  onJoin: (inviteCode: string, name: string) => Promise<Space>
  onJoined?: (space: Space) => void
}

export default function JoinSpaceModal({ isOpen, initialCode, initialName, onClose, onJoin, onJoined }: JoinSpaceModalProps) {
  const { t } = useTranslation()
  const { t: tErr } = useTranslation('errors')
  const [inviteCode, setInviteCode] = useState(initialCode ?? '')
  const [name, setName] = useState(initialName ?? '')
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastSuggestedNameRef = useRef<string>(initialName ?? '')

  useEffect(() => {
    if (!isOpen) return
    if (initialCode) setInviteCode(initialCode)
    if (initialName) {
      setName(initialName)
      lastSuggestedNameRef.current = initialName
    }
  }, [isOpen, initialCode, initialName])

  useEffect(() => {
    const decoded = decodeInvite(inviteCode)
    const suggested = decoded && decoded.v === 1 ? decoded.name : undefined
    if (!suggested) return
    if (name === '' || name === lastSuggestedNameRef.current) {
      setName(suggested)
      lastSuggestedNameRef.current = suggested
    }
  }, [inviteCode])

  function handleClose() {
    setInviteCode('')
    setName('')
    lastSuggestedNameRef.current = ''
    setError(null)
    onClose()
  }

  async function handleJoin() {
    if (!inviteCode.trim() || joining) return
    setJoining(true)
    setError(null)
    try {
      const space = await onJoin(inviteCode.trim(), name.trim() || t('joinSpace.defaultName'))
      setInviteCode('')
      setName('')
      lastSuggestedNameRef.current = ''
      onClose()
      onJoined?.(space)
    } catch (err) {
      setError(err instanceof Error ? err.message : tErr('joinFailed'))
    } finally {
      setJoining(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} onConfirm={handleJoin} ariaLabel={t('joinSpace.title')} panelClassName="glass-modal w-full max-w-md rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative">
      <>
        <div className="px-10 pt-10 pb-6">
          <div className="flex justify-between items-start mb-2">
            <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight">
              {t('joinSpace.title')}
            </h1>
            <IconButton
              icon="close"
              onClick={handleClose}
              ariaLabel={t('actions.close')}
              iconClassName="text-secondary"
            />
          </div>
          <p className="text-on-surface-variant font-medium text-sm">{t('joinSpace.desc')}</p>
        </div>
        <div className="px-10 pb-10 space-y-6">
          <div className="space-y-3">
            <label htmlFor="join-space-code" className="font-headline text-sm font-bold text-accent px-1">{t('joinSpace.codeLabel')}</label>
            <input id="join-space-code" autoFocus aria-invalid={error ? true : undefined} aria-describedby={error ? 'join-space-error' : undefined} className="w-full bg-surface-container-low border-none focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 rounded-xl px-6 py-4 text-accent font-medium placeholder:text-outline/50 transition-all font-mono text-sm" placeholder={t('joinSpace.codePlaceholder')} value={inviteCode} onChange={(e) => { setInviteCode(extractInviteCode(e.target.value)); setError(null) }} onKeyDown={(e) => e.key === 'Enter' && handleJoin()} />
          </div>
          <div className="space-y-3">
            <label htmlFor="join-space-name" className="font-headline text-sm font-bold text-accent px-1">{t('joinSpace.nameLabel')}</label>
            <input id="join-space-name" className="w-full bg-surface-container-low border-none focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 rounded-xl px-6 py-4 text-accent font-medium placeholder:text-outline/50 transition-all" placeholder={t('joinSpace.namePlaceholder')} value={name} onChange={(e) => { setName(e.target.value); setError(null) }} onKeyDown={(e) => e.key === 'Enter' && handleJoin()} />
          </div>
          {error && (
            <div id="join-space-error" className="rounded-xl bg-error-container/60 px-5 py-3 text-sm font-medium text-on-error-container" role="alert">
              {error}
            </div>
          )}
          <Button size="lg" fullWidth onClick={handleJoin} disabled={!inviteCode.trim() || joining}>
            {joining ? t('joinSpace.joining') : t('joinSpace.action')}
            <Icon name="group_add" />
          </Button>
        </div>
      </>
    </Modal>
  )
}
