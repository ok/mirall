// Routes OS-notification clicks to app actions (reveal file, focus window, navigate to space) by payload kind.
import { useEffect } from 'react'
import { PATH_HOST } from '../../shared/contract/paths.js'
import { request } from '../ipc/ipc.js'
import type { NotificationClickPayload } from '../platform/global.js'

// A completed download is revealed by whoever owns the disk it landed on. A daemon path goes back
// to the daemon — the same reveal every button in the app already uses — and is never handed to
// this machine's shell, which would open nothing or, worse, a different file of the same name.
// Anything that is not explicitly the client's is the daemon's: an untagged payload from an older
// renderer still on screen must not reach the shell either.
async function revealCompleted(payload: Extract<NotificationClickPayload, { spaceId: string }>): Promise<boolean> {
  if (payload.host === PATH_HOST.CLIENT) {
    if (!payload.localPath) return false
    const res = await window.bridge.showInFolder({ path: payload.localPath, host: payload.host })
    return res?.ok === true
  }
  if (!payload.path) return false
  try {
    await request('files:reveal', { spaceId: payload.spaceId, path: payload.path })
    return true
  } catch {
    return false
  }
}

export function useNotificationClickRouter(navigateToSpace: (spaceId: string) => void): void {
  useEffect(() => {
    const unsub = window.bridge.onNotificationClick(({ payload }) => {
      if (!payload) return
      switch (payload.kind) {
        case 'transfer-complete':
          // A reveal that does not happen would otherwise make the click do nothing at all.
          void revealCompleted(payload).then((revealed) => {
            if (!revealed) void window.bridge.focusWindow()
          })
          return
        case 'member-joined':
        case 'member-left':
          void window.bridge.focusWindow()
          return
        case 'transfer-error':
        case 'transfer-paused':
          void window.bridge.focusWindow()
          navigateToSpace(payload.spaceId)
          return
      }
    })
    return unsub
  }, [navigateToSpace])
}
