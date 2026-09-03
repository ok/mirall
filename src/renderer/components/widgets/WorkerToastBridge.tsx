// Renderless bridge mapping worker wire events onto in-app toasts — the one place a
// background event earns foreground attention. Only terminal, user-actionable failures
// belong here; transient errors stay on the row state and self-heal via auto-resume.
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { subscribe } from '../../ipc.js'
import { useToast } from '../toast/ToastProvider.js'
import { basename } from '../../sharePaths.js'
import { isMountFault } from '../../mountFault.js'
import { mountFaultReasonKey } from '../../errorMessages.js'

interface TransferSupersededMessage {
  transferId: string
  fileName: string
}

interface TransferRemovedMessage {
  transferId: string
  path: string
  fileName: string
}

interface TransferErrorMessage {
  transferId: string
  path: string
  errorCode?: string
}

interface MountStatusMessage {
  spaceId: string
  shareId: string
  status: string
  error?: string
}

export default function WorkerToastBridge() {
  const { t } = useTranslation()
  const { t: tErr } = useTranslation('errors')
  const toast = useToast()

  useEffect(() => {
    const unsubs = [
      subscribe<TransferSupersededMessage>('event:transfer-superseded', (msg) => {
        toast.info(t('file.sourceChangedRestarting', { name: msg.fileName }), {
          id: 'superseded:' + msg.transferId,
          duration: 8000,
        })
      }),
      subscribe<TransferRemovedMessage>('event:transfer-removed', (msg) => {
        toast.info(t('file.downloadRemovedByOwner', { name: msg.fileName }), {
          id: 'removed:' + msg.transferId,
          duration: 8000,
        })
      }),
      subscribe<TransferErrorMessage>('event:transfer-error', (msg) => {
        if (msg.errorCode === 'TRANSFER_DISK_FULL') {
          toast.error(t('file.transferDiskFullToast', { name: basename(msg.path) }), {
            id: 'disk-full:' + msg.transferId,
            duration: 8000,
          })
        } else if (msg.errorCode === 'TRANSFER_CHECKSUM') {
          toast.error(t('file.transferChecksumToast', { name: basename(msg.path) }), {
            id: 'checksum:' + msg.transferId,
            duration: 8000,
          })
        }
      }),
      // Both fault statuses, and the reason translated: `error` carries an error CODE now, and
      // passing it through raw is how "ENOSPC: no space left on device, write '/Users/…'" reached
      // the user in every language. The folder screen's fault strip is the durable surface; this
      // stays as the notice you get while looking at something else.
      subscribe<MountStatusMessage>('event:owned-folder-mount-status', (msg) => {
        if (!isMountFault(msg.status)) return
        toast.error(t('folder.syncPausedToast', { reason: tErr(mountFaultReasonKey(msg.error)) }), {
          id: 'mount-error:' + msg.shareId,
          duration: 8000,
        })
      }),
      subscribe<MountStatusMessage>('event:foreign-folder-mount-status', (msg) => {
        if (!isMountFault(msg.status)) return
        toast.error(t('folder.mirrorPausedToast', { reason: tErr(mountFaultReasonKey(msg.error)) }), {
          id: 'mount-error:' + msg.shareId,
          duration: 8000,
        })
      }),
    ]
    return () => { for (const unsub of unsubs) unsub() }
  }, [t, tErr, toast])

  return null
}
