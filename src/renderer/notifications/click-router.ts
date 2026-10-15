// Routes OS-notification clicks to app actions (reveal file, focus window, navigate to space) by payload kind.
import { useEffect } from 'react'
import { PATH_HOST } from '../../shared/contract/paths.js'
import { request } from '../ipc/ipc.js'
import { revealOnClient } from '../platform/reveal-client.js'
import type { TransferClickPayload } from '../platform/global.js'

// A completed download is revealed by whoever owns the disk it landed on. A client path goes to
// this machine's shell as it is. A daemon path goes back to the daemon first — the same reveal
// every button in the app uses — and only the path the worker answers reaches the shell gate, so
// an untagged payload from an older renderer still on screen is never handed over as the client's.
async function revealCompleted(payload: TransferClickPayload): Promise<boolean> {
  if (payload.host === PATH_HOST.CLIENT) {
    if (!payload.localPath) return false
    const res = await window.bridge.showInFolder({ path: payload.localPath, exists: true, host: payload.host })
    return res?.ok === true
  }
  if (!payload.path) return false
  try {
    await revealOnClient(await request('files:reveal', { spaceId: payload.spaceId, path: payload.path }))
    return true
  } catch {
    return false
  }
}

function focusWindow(): void {
  window.bridge.focusWindow().catch((err) => console.error('focusWindow failed:', err))
}

export function useNotificationClickRouter(navigateToSpace: (spaceId: string) => void): void {
  useEffect(() => {
    const unsub = window.bridge.onNotificationClick(({ payload }) => {
      if (!payload) return
      switch (payload.kind) {
        case 'transfer-complete':
          // A reveal that does not happen would otherwise make the click do nothing at all.
          revealCompleted(payload).then((revealed) => {
            if (!revealed) focusWindow()
          }, (err) => {
            console.error('reveal failed:', err)
            focusWindow()
          })
          return
        case 'presence':
        case 'membership-denied':
          focusWindow()
          return
        case 'join-request':
        case 'membership-granted':
        case 'new-shares':
        case 'file-received':
        case 'mirror-synced':
        case 'transfer-error':
        case 'transfer-paused':
          focusWindow()
          navigateToSpace(payload.spaceId)
          return
      }
    })
    return unsub
  }, [navigateToSpace])
}
