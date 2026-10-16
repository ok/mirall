// Unshares several of your loose files at once. One confirmation for the batch; the files go one
// request each, since a remove is per path and writes one audit row per file, which is the record
// we want. The modal reports the outcome itself, so it does not also go through useRunAction.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../ipc/ipc.js'
import { useToast } from '../toast/ToastProvider.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import ConfirmDestructiveModal from './ConfirmDestructiveModal.js'
import type { FileEntry } from '../../types/types.js'

interface UnshareFilesModalProps {
  isOpen: boolean
  spaceId: string
  files: readonly FileEntry[]
  onClose: () => void
  /** Called once the batch has been sent, whatever each file's outcome. */
  onDone: () => void
}

export default function UnshareFilesModal({ isOpen, spaceId, files, onClose, onDone }: UnshareFilesModalProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const [busy, setBusy] = useState(false)
  const count = files.length

  async function confirm() {
    if (busy) return
    setBusy(true)
    const results = await Promise.allSettled(files.map((f) => request('files:remove', { spaceId, path: f.path })))
    setBusy(false)
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed === 0) toast.success(t('unshareFiles.done', { count }))
    else toast.error(t('unshareFiles.partial', { done: count - failed, total: count, failed }))
    onDone()
  }

  return (
    <ConfirmDestructiveModal
      isOpen={isOpen}
      title={t('unshareFiles.title', { count })}
      body={t('unshareFiles.body', { count })}
      confirmLabel={busy ? t('unshareFiles.removing') : t('unshareFiles.action', { count })}
      busy={busy}
      onClose={onClose}
      onConfirm={() => { confirm().catch((err) => { setBusy(false); toast.error(errorText(err)) }) }}
    />
  )
}
