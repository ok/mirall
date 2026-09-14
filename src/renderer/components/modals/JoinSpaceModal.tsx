// Join-a-space form: accepts a pasted invite code or link and pre-fills the
// space name from the invite envelope.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Space } from '../../types.js'
import { decodeInvite, extractInviteCode } from '../../../shared/contract/invite-envelope.js'
import Modal from '../primitives/Modal.js'
import TextField from '../primitives/TextField.js'
import Icon from '../primitives/Icon.js'
import ModalHeader from '../primitives/ModalHeader.js'
import Button from '../primitives/Button.js'
import { useErrorText } from '../../hooks/useErrorText.js'

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
  const errorText = useErrorText()
  const [inviteCode, setInviteCode] = useState(initialCode ?? '')
  const [name, setName] = useState(initialName ?? '')
  const [joining, setJoining] = useState(false)
  const joiningRef = useRef(false)
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

  // Auto-fill the name from the invite, but only while the field is still the machine's: empty, or
  // exactly the last value this effect wrote. Once the user has typed anything of their own, a
  // pasted invite must not overwrite it.
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
    if (!inviteCode.trim() || joining || joiningRef.current) return
    joiningRef.current = true
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
      setError(errorText(err))
    } finally {
      joiningRef.current = false
      setJoining(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} onConfirm={handleJoin} ariaLabel={t('joinSpace.title')} panelClassName="glass-modal w-full max-w-md rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative">
      <>
        <ModalHeader
          title={t('joinSpace.title')}
          description={t('joinSpace.desc')}
          descriptionSize="sm"
          onClose={handleClose}
        />
        <div className="px-10 pb-10 space-y-6">
          {/* The failure is one message under both fields, not one per field: an invite code that
              the space rejects is not a fault of either box on its own. */}
          <TextField
            id="join-space-code"
            label={t('joinSpace.codeLabel')}
            autoFocus
            mono
            invalid={!!error}
            describedBy={error ? 'join-space-error' : undefined}
            placeholder={t('joinSpace.codePlaceholder')}
            value={inviteCode}
            onChange={(v) => { setInviteCode(extractInviteCode(v)); setError(null) }}
          />
          <TextField
            id="join-space-name"
            label={t('joinSpace.nameLabel')}
            placeholder={t('joinSpace.namePlaceholder')}
            value={name}
            onChange={(v) => { setName(v); setError(null) }}
          />
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
