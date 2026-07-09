// Subscribes to worker member/transfer events and shows OS notifications per user prefs, with join-flap dedupe.
import i18n from '../i18n.js'
import { subscribe } from '../ipc.js'
import type { NotificationSpec } from '../global.d.js'
import { errorCodeToI18nKey } from '../errorMessages.js'
import { getPrefs } from './prefs.js'
import { pausedBodyKey } from './pausedToast.js'

interface MemberJoinedMessage {
  type: 'event:member-joined'
  spaceId: string
  member: { publicKey: string; displayName?: string; avatar?: string | null }
}

interface MemberLeftMessage {
  type: 'event:member-left'
  spaceId: string
  publicKey: string
}

interface TransferCompleteMessage {
  type: 'event:transfer-complete'
  transferId: string
  spaceId: string
  path: string
  localPath: string
}

interface TransferErrorMessage {
  type: 'event:transfer-error'
  transferId: string
  spaceId: string
  path: string
  errorCode?: string
}

interface TransferPausedMessage {
  type: 'event:transfer-paused'
  transferId: string
  spaceId: string
  path: string
  reason?: string
}

export interface DispatcherDeps {
  getMemberName(spaceId: string, publicKey: string): string | null
}

const joinedShown = new Set<string>()
const JOIN_FORGET_MS = 5 * 60_000

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

async function show(spec: NotificationSpec): Promise<void> {
  const prefs = getPrefs()
  if (!prefs.enabled) return
  if (prefs.suppressWhenFocused && (await window.bridge.isWindowFocused())) return
  await window.bridge.notify({
    ...spec,
    silent: spec.silent ?? !prefs.sound,
  })
}

export function startNotifications(deps: DispatcherDeps): () => void {
  const t = i18n.t.bind(i18n)
  const tErr = i18n.getFixedT(null, 'errors')
  const unsubs: Array<() => void> = []

  unsubs.push(subscribe<MemberJoinedMessage>('event:member-joined', (msg) => {
    if (!getPrefs().events.memberJoined) return
    const peerKey = msg.member.publicKey

    // Suppress repeats within JOIN_FORGET_MS — keeps swarm flap (sleep/wake,
    // timeout/reconnect) from re-firing the toast on the same peer.
    if (joinedShown.has(peerKey)) return

    joinedShown.add(peerKey)
    setTimeout(() => joinedShown.delete(peerKey), JOIN_FORGET_MS)

    const displayName = msg.member.displayName?.trim() || t('notifications.fallbackPeerName')
    const avatar = msg.member.avatar ?? null

    const spec: NotificationSpec = {
      id: `member-joined:${peerKey}`,
      title: displayName,
      body: t('notifications.memberJoinedBodyNoSpace'),
      payload: { kind: 'member-joined' },
    }
    if (avatar) spec.icon = avatar

    void show(spec)
  }))

  unsubs.push(subscribe<MemberLeftMessage>('event:member-left', (msg) => {
    if (!getPrefs().events.memberLeft) return
    const displayName = deps.getMemberName(msg.spaceId, msg.publicKey) ?? t('notifications.fallbackPeerName')
    void show({
      id: `member-left:${msg.publicKey}`,
      title: displayName,
      body: t('notifications.memberLeftBodyNoSpace'),
      payload: { kind: 'member-left' },
    })
  }))

  unsubs.push(subscribe<TransferCompleteMessage>('event:transfer-complete', (msg) => {
    if (!getPrefs().events.transferComplete) return
    if (!msg.localPath) return
    const fileName = basename(msg.path)
    void show({
      id: `transfer-complete:${msg.transferId}`,
      title: t('notifications.transferCompleteTitle'),
      body: fileName,
      groupId: `space:${msg.spaceId}`,
      payload: {
        kind: 'transfer-complete',
        spaceId: msg.spaceId,
        localPath: msg.localPath,
        path: msg.path,
      },
    })
  }))

  unsubs.push(subscribe<TransferErrorMessage>('event:transfer-error', (msg) => {
    if (!getPrefs().events.transferError) return
    const fileName = basename(msg.path)
    const reason = tErr(errorCodeToI18nKey(msg.errorCode))
    void show({
      id: `transfer-error:${msg.transferId}`,
      title: t('notifications.transferErrorTitle'),
      body: t('notifications.transferErrorBody', { file: fileName, reason }),
      urgency: 'critical',
      groupId: `space:${msg.spaceId}`,
      payload: { kind: 'transfer-error', spaceId: msg.spaceId, path: msg.path },
    })
  }))

  unsubs.push(subscribe<TransferPausedMessage>('event:transfer-paused', (msg) => {
    if (!getPrefs().events.transferPaused) return
    const fileName = basename(msg.path)
    const bodyKey = pausedBodyKey(msg.reason)
    void show({
      id: `transfer-paused:${msg.transferId}`,
      title: t('notifications.transferPausedTitle'),
      body: t(bodyKey, { file: fileName }),
      groupId: `space:${msg.spaceId}`,
      payload: { kind: 'transfer-paused', spaceId: msg.spaceId, path: msg.path },
    })
  }))

  return () => unsubs.forEach((u) => u())
}
