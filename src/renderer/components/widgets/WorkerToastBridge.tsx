// Renderless bridge mapping worker wire events onto in-app toasts — the one place a
// background event earns foreground attention. Only terminal, user-actionable failures
// belong here; transient errors stay on the row state and self-heal via auto-resume.
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { subscribe } from '../../ipc.js'
import { useToast } from '../toast/ToastProvider.js'
import { basename } from '../../sharePaths.js'

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
      subscribe<MountStatusMessage>('event:owned-folder-mount-status', (msg) => {
        if (msg.status !== 'paused-error') return
        toast.error(t('folder.syncPausedToast', { reason: msg.error ?? tErr('transferFailed') }), {
          id: 'mount-error:' + msg.shareId,
          duration: 8000,
        })
      }),
      subscribe<MountStatusMessage>('event:foreign-folder-mount-status', (msg) => {
        if (msg.status !== 'paused-error') return
        toast.error(t('folder.mirrorPausedToast', { reason: msg.error ?? tErr('transferFailed') }), {
          id: 'mount-error:' + msg.shareId,
          duration: 8000,
        })
      }),
    ]
    return () => { for (const unsub of unsubs) unsub() }
  }, [t, tErr, toast])

  return null
}
