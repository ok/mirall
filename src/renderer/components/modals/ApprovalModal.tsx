// Review dialog for pending join requests: approve all, approve a selection, or deny individually.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { JoinRequest } from '../../types.js'
import Modal from '../primitives/Modal.js'
import Avatar from '../primitives/Avatar.js'
import Button from '../primitives/Button.js'
import IconButton from '../primitives/IconButton.js'

interface ApprovalModalProps {
  isOpen: boolean
  requests: JoinRequest[]
  busyKeys: Set<string>
  onApprove: (publicKey: string) => void
  onDeny: (publicKey: string) => void
  onClose: () => void
}

export default function ApprovalModal({ isOpen, requests, busyKeys, onApprove, onDeny, onClose }: ApprovalModalProps) {
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

  function approveAll() {
    requests.forEach((r) => onApprove(r.publicKey))
    onClose()
  }

  function approveSelected() {
    selected.forEach((k) => onApprove(k))
    onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} ariaLabel={t('space.joinRequests')} panelClassName="glass-modal w-full max-w-xl rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative">
      <div className="px-10 pt-10 pb-5 flex items-start justify-between">
        <div>
          <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight">{t('space.joinRequests')}</h1>
          <p className="text-on-surface-variant text-sm mt-1">{t('space.joinRequestsDesc')}</p>
        </div>
        <IconButton icon="close" onClick={onClose} ariaLabel={t('actions.close')} iconClassName="text-secondary" />
      </div>
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
      <div className="px-10 pb-10 pt-2 flex gap-3">
        <Button size="lg" variant="secondary" className="flex-1" onClick={approveAll}>
          {t('space.approveAll', { count: requests.length })}
        </Button>
        <Button size="lg" variant="primary" className="flex-1" disabled={selected.size === 0} onClick={approveSelected}>
          {t('space.approveSelected', { count: selected.size })}
        </Button>
      </div>
    </Modal>
  )
}
