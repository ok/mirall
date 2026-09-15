// Renderless bridge surfacing membership traffic app-wide, so existing members notice a join
// request even when they are not looking at the space. Review navigates to the space, where the
// banner (and modal for several requests) holds the actual Approve/Deny controls. Three rules:
// a pending approval is sticky, its toast id is deterministic, and it is dismissed the moment the
// request is resolved by ANY member, because approval only needs doing once.
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { request, subscribe } from '../../../ipc/ipc.js'
import { useSpaces } from '../../../hooks/useSpaces.js'
import { useToast } from '../ToastProvider.js'

interface JoinRequestMessage {
  spaceId: string
  publicKey: string
  displayName: string
}

interface SpaceMessage {
  spaceId: string
}

interface MemberJoinedMessage {
  spaceId: string
  member?: { publicKey?: string }
}

interface PendingRequestRow {
  publicKey: string
}

interface JoinRequestToastBridgeProps {
  navigateToSpace: (spaceId: string) => void
}

const toastId = (spaceId: string, publicKey: string) => `join-req:${spaceId}:${publicKey}`

export default function JoinRequestToastBridge({ navigateToSpace }: JoinRequestToastBridgeProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const { spaces } = useSpaces()
  const spacesRef = useRef(spaces)
  spacesRef.current = spaces
  const shownRef = useRef<Map<string, Set<string>>>(new Map())

  useEffect(() => {
    const nameOf = (spaceId: string) => spacesRef.current.find((s) => s.spaceId === spaceId)?.name ?? ''
    const remember = (spaceId: string, publicKey: string) => {
      let set = shownRef.current.get(spaceId)
      if (!set) shownRef.current.set(spaceId, set = new Set())
      set.add(publicKey)
    }
    const dismissFor = (spaceId: string, publicKey: string) => {
      toast.dismiss(toastId(spaceId, publicKey))
      shownRef.current.get(spaceId)?.delete(publicKey)
    }

    const unsubReq = subscribe<JoinRequestMessage>('event:member-join-request', (msg) => {
      remember(msg.spaceId, msg.publicKey)
      toast.info(t('member.joinRequestToast', { name: msg.displayName, space: nameOf(msg.spaceId) }), {
        id: toastId(msg.spaceId, msg.publicKey),
        duration: 0,
        action: { label: t('member.review'), onClick: () => navigateToSpace(msg.spaceId) },
      })
    })
    // The pending set changed, possibly on another member's peer: re-read it and dismiss every
    // toast no longer backed by a live request.
    const unsubResolved = subscribe<SpaceMessage>('event:join-requests-updated', (msg) => {
      const shown = shownRef.current.get(msg.spaceId)
      if (!shown || shown.size === 0) return
      request('space:pending-requests', { spaceId: msg.spaceId }).then((result) => {
        const pending = new Set((result as PendingRequestRow[]).map((r) => r.publicKey))
        for (const publicKey of [...shown]) if (!pending.has(publicKey)) dismissFor(msg.spaceId, publicKey)
      }).catch(() => {})
    })
    const unsubJoined = subscribe<MemberJoinedMessage>('event:member-joined', (msg) => {
      if (msg.member?.publicKey) dismissFor(msg.spaceId, msg.member.publicKey)
    })
    const unsubGranted = subscribe<SpaceMessage>('event:membership-granted', (msg) => {
      toast.success(t('member.membershipGranted', { space: nameOf(msg.spaceId) }), {
        action: { label: t('member.open'), onClick: () => navigateToSpace(msg.spaceId) },
      })
    })
    const unsubDenied = subscribe<SpaceMessage>('event:membership-denied', (msg) => {
      toast.error(t('member.membershipDenied', { space: nameOf(msg.spaceId) }), { duration: 0 })
    })
    return () => { unsubReq(); unsubResolved(); unsubJoined(); unsubGranted(); unsubDenied() }
  }, [navigateToSpace, t, toast])

  return null
}
