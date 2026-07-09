// Routes OS-notification clicks to app actions (reveal file, focus window, navigate to space) by payload kind.
import { useEffect } from 'react'

export interface ClickRouterDeps {
  navigateToSpace(spaceId: string): void
}

export function useNotificationClickRouter(deps: ClickRouterDeps): void {
  useEffect(() => {
    const unsub = window.bridge.onNotificationClick(({ payload }) => {
      if (!payload) return
      switch (payload.kind) {
        case 'transfer-complete':
          if (payload.localPath) void window.bridge.showInFolder(payload.localPath)
          return
        case 'member-joined':
        case 'member-left':
          void window.bridge.focusWindow()
          return
        case 'transfer-error':
        case 'transfer-paused':
          void window.bridge.focusWindow()
          deps.navigateToSpace(payload.spaceId)
          return
      }
    })
    return unsub
  }, [deps])
}
