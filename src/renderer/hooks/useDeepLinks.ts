import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../components/toast/ToastProvider.js'
import { routeDeepLink } from '../model/deep-link-route.js'
import type { AppDialog } from '../components/modals/AppDialogs.js'
import type { DeepLinkPayload } from '../platform/global.js'
import type { Space } from '../types/types.js'

export interface DeepLinkQueue {
  links: DeepLinkPayload[]
  drain: () => void
}

// The queue is subscribed above the boot gate and drained below it: a link that arrives during boot
// or onboarding waits for the shell, and the drain needs the toast provider the shell mounts.
export function useDeepLinkQueue(): DeepLinkQueue {
  const [links, setLinks] = useState<DeepLinkPayload[]>([])
  useEffect(() => {
    return window.bridge.deepLink.subscribe((link) => {
      setLinks((q) => [...q, link])
    })
  }, [])
  const drain = useCallback(() => setLinks([]), [])
  return useMemo(() => ({ links, drain }), [links, drain])
}

interface DeepLinkRouterArgs {
  queue: DeepLinkQueue
  spaces: Space[]
  navigateToSpace: (spaceId: string) => void
  openDialog: (dialog: AppDialog) => void
}

export function useDeepLinkRouter({ queue, spaces, navigateToSpace, openDialog }: DeepLinkRouterArgs): void {
  const { t } = useTranslation()
  const toast = useToast()
  const spacesRef = useRef(spaces)
  spacesRef.current = spaces

  useEffect(() => {
    if (queue.links.length === 0) return
    for (const link of queue.links) {
      const route = routeDeepLink(link, spacesRef.current, Date.now())
      switch (route.kind) {
        case 'invalid':
          toast.error(t('joinSpace.invalidLink'))
          break
        case 'expired':
          toast.error(t('joinSpace.expiredLink'))
          break
        case 'member':
          navigateToSpace(route.space.spaceId)
          toast.info(t('joinSpace.alreadyMember', { name: route.space.name }))
          break
        case 'join':
          openDialog({ kind: 'join', code: route.code, name: route.name })
          break
      }
    }
    queue.drain()
  }, [queue, navigateToSpace, openDialog, t, toast])
}
