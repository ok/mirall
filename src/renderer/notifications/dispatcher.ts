// Subscribes to worker member/transfer events and shows OS notifications per user prefs, with join-flap
// dedupe and per-file transfer bursts coalesced (coalesce.js).
import type { PathHost } from '../../shared/contract/paths.js'
import i18n from '../platform/i18n.js'
import { subscribe } from '../ipc/ipc.js'
import type { NotificationSpec } from '../platform/global.d.js'
import { errorCodeToI18nKey } from '../errors/error-messages.js'
import { getPrefs, type NotificationEventPrefs } from './prefs.js'
import { pausedBodyKey, pausedManyBodyKey } from './pausedToast.js'
import { createCoalescer } from './coalesce.js'

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
  // Whose disk localPath is on; the click router refuses to hand a daemon path to this machine.
  host?: PathHost
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
// A folder download completes, fails or pauses every file within seconds of each other.
const BURST_WINDOW_MS = 3000
const BURST_CAP_MS = 10_000

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

function show(spec: NotificationSpec): void {
  present(spec).catch((err) => console.error('notification failed:', err))
}

async function present(spec: NotificationSpec): Promise<void> {
  const prefs = getPrefs()
  if (!prefs.enabled) return
  if (prefs.suppressWhenFocused && (await window.bridge.isWindowFocused())) return
  await window.bridge.notify({
    ...spec,
    silent: spec.silent ?? !prefs.sound,
  })
}

// One notification per burst: `spec` builds it for an episode, with `count` 1 for the first file.
// The summary reuses its episode's id, so main replaces that episode's notification and no other.
function coalesced<T extends { transferId: string }>(
  pref: keyof NotificationEventPrefs,
  spec: (msg: T, count: number, episode: number) => NotificationSpec,
) {
  return createCoalescer<T>({
    windowMs: BURST_WINDOW_MS,
    capMs: BURST_CAP_MS,
    onLeading: (ep) => { show(spec(ep.data, 1, ep.seq)) },
    onSummary: (ep) => { if (getPrefs().events[pref]) show(spec(ep.data, ep.count, ep.seq)) },
  })
}

export function startNotifications(deps: DispatcherDeps): () => void {
  const t = i18n.t.bind(i18n)
  const tErr = i18n.getFixedT(null, 'errors')
  const unsubs: Array<() => void> = []

  unsubs.push(subscribe<MemberJoinedMessage>('event:member-joined', (msg) => {
    if (!getPrefs().events.memberJoined) return
    const personKey = msg.member.publicKey

    // Suppress repeats within JOIN_FORGET_MS — keeps swarm flap (sleep/wake,
    // timeout/reconnect) from re-firing the toast on the same peer.
    if (joinedShown.has(personKey)) return

    joinedShown.add(personKey)
    setTimeout(() => joinedShown.delete(personKey), JOIN_FORGET_MS)

    const displayName = msg.member.displayName?.trim() || t('notifications.fallbackPeerName')
    const avatar = msg.member.avatar ?? null

    const spec: NotificationSpec = {
      id: `member-joined:${personKey}`,
      title: displayName,
      body: t('notifications.memberJoinedBodyNoSpace'),
      payload: { kind: 'member-joined' },
    }
    if (avatar) spec.icon = avatar

    show(spec)
  }))

  unsubs.push(subscribe<MemberLeftMessage>('event:member-left', (msg) => {
    if (!getPrefs().events.memberLeft) return
    const displayName = deps.getMemberName(msg.spaceId, msg.publicKey) ?? t('notifications.fallbackPeerName')
    show({
      id: `member-left:${msg.publicKey}`,
      title: displayName,
      body: t('notifications.memberLeftBodyNoSpace'),
      payload: { kind: 'member-left' },
    })
  }))

  const completed = coalesced<TransferCompleteMessage>('transferComplete', (msg, count, episode) => ({
    id: `transfer-complete:${msg.spaceId}:${episode}`,
    title: t('notifications.transferCompleteTitle'),
    body: count > 1 ? t('notifications.transferCompleteManyBody', { count }) : basename(msg.path),
    groupId: `space:${msg.spaceId}`,
    payload: { kind: 'transfer-complete', spaceId: msg.spaceId, localPath: msg.localPath, path: msg.path },
  }))
  unsubs.push(subscribe<TransferCompleteMessage>('event:transfer-complete', (msg) => {
    if (!getPrefs().events.transferComplete) return
    if (!msg.localPath) return
    completed.hit(msg.spaceId, msg.transferId, msg)
  }))

  const failed = coalesced<TransferErrorMessage>('transferError', (msg, count, episode) => {
    const reason = tErr(errorCodeToI18nKey(msg.errorCode))
    return {
      id: `transfer-error:${msg.spaceId}:${msg.errorCode ?? ''}:${episode}`,
      title: t('notifications.transferErrorTitle'),
      body: count > 1
        ? t('notifications.transferErrorManyBody', { count, reason })
        : t('notifications.transferErrorBody', { file: basename(msg.path), reason }),
      urgency: 'critical',
      groupId: `space:${msg.spaceId}`,
      payload: { kind: 'transfer-error', spaceId: msg.spaceId, path: msg.path },
    }
  })
  unsubs.push(subscribe<TransferErrorMessage>('event:transfer-error', (msg) => {
    if (!getPrefs().events.transferError) return
    failed.hit(`${msg.spaceId}:${msg.errorCode ?? ''}`, msg.transferId, msg)
  }))

  const paused = coalesced<TransferPausedMessage>('transferPaused', (msg, count, episode) => ({
    id: `transfer-paused:${msg.spaceId}:${pausedBodyKey(msg.reason)}:${episode}`,
    title: t('notifications.transferPausedTitle'),
    body: count > 1 ? t(pausedManyBodyKey(msg.reason), { count }) : t(pausedBodyKey(msg.reason), { file: basename(msg.path) }),
    groupId: `space:${msg.spaceId}`,
    payload: { kind: 'transfer-paused', spaceId: msg.spaceId, path: msg.path },
  }))
  unsubs.push(subscribe<TransferPausedMessage>('event:transfer-paused', (msg) => {
    if (!getPrefs().events.transferPaused) return
    paused.hit(`${msg.spaceId}:${pausedBodyKey(msg.reason)}`, msg.transferId, msg)
  }))

  return () => {
    unsubs.forEach((u) => u())
    for (const bursts of [completed, failed, paused]) bursts.close()
  }
}
