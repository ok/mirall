// Review dialog for pending join requests: approve all, approve a selection, or deny individually.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ModalFooter from '../layout/ModalFooter.js'
import type { JoinRequest } from '../../types/types.js'
import Modal from '../primitives/Modal.js'
import Avatar from '../primitives/Avatar.js'
import Button from '../primitives/Button.js'
import IconButton from '../primitives/IconButton.js'
import ModalHeader from '../primitives/ModalHeader.js'

interface ApprovalModalProps {
  isOpen: boolean
  requests: JoinRequest[]
  busyKeys: Set<string>
  onApproveMany: (publicKeys: string[]) => void
  onDeny: (publicKey: string) => void
  onClose: () => void
}

export default function ApprovalModal({ isOpen, requests, busyKeys, onApproveMany, onDeny, onClose }: ApprovalModalProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Close once every request is resolved (approved or denied) so the dialog never
  // lingers empty.
  useEffect(() => {
    if (isOpen && requests.length === 0) onClose()
  }, [isOpen, requests.length, onClose])

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Approve closes rather than waiting, and busyKeys gates Deny alone. The asymmetry is
  // deliberate: approving is the expected outcome and its progress is visible on the space screen
  // the modal closes onto, while a deny is destructive and must not be issued twice. The batch goes
  // out as one call so its outcome can be reported once, rather than as N calls nothing joins back up.
  function approveAll() {
    onApproveMany(requests.map((r) => r.publicKey))
    onClose()
  }

  function approveSelected() {
    onApproveMany([...selected])
    onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} onConfirm={selected.size > 0 ? approveSelected : undefined} ariaLabel={t('space.joinRequests')} panelClassName="glass-modal w-full max-w-xl rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative">
      <ModalHeader
        title={t('space.joinRequests')}
        description={t('space.joinRequestsDesc')}
        descriptionSize="sm"
        onClose={onClose}
      />
      <ul className="px-10 pb-4 space-y-2 max-h-64 overflow-y-auto scrollbar-thin">
        {requests.map((r) => (
          <li key={r.publicKey} className="flex items-center gap-3 rounded-xl bg-surface-container-low p-3">
            <input
              type="checkbox"
              checked={selected.has(r.publicKey)}
              onChange={() => toggle(r.publicKey)}
              aria-label={t('space.selectNamed', { name: r.displayName })}
              className="w-5 h-5 accent-primary"
            />
            <Avatar src={r.avatar} displayName={r.displayName} size="md" />
            <p className="flex-1 min-w-0 font-bold text-accent truncate">{r.displayName}</p>
            <IconButton icon="close" disabled={busyKeys.has(r.publicKey)} onClick={() => onDeny(r.publicKey)} ariaLabel={t('member.denyNamed', { name: r.displayName })} iconClassName="text-secondary" />
          </li>
        ))}
      </ul>
      <ModalFooter layout="split" className="px-10 pb-10">
        <Button size="lg" variant="secondary" onClick={approveAll}>
          {t('space.approveAll', { count: requests.length })}
        </Button>
        <Button size="lg" variant="primary" disabled={selected.size === 0} onClick={approveSelected}>
          {t('space.approveSelected', { count: selected.size })}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
