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
          // A reveal main refuses (path outside home and every download root) would
          // otherwise make the click do nothing at all.
          if (payload.localPath) {
            void window.bridge.showInFolder(payload.localPath).then((res) => {
              if (!res?.ok) void window.bridge.focusWindow()
            })
          }
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
