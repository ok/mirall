// Subscribes to worker membership, activity and transfer events and shows OS notifications per user
// prefs: presence deduped per person across spaces, bursts coalesced per person or per space
// (coalesce.js), and a join request's alert closed once any member resolves it.
import type { PathHost } from '../../shared/contract/paths.js'
import type { ActivityEvent } from '../../shared/contract/responses.js'
import { NOTIFIABLE_KIND } from '../../shared/contract/audit-kinds.js'
import i18n from '../platform/i18n.js'
import { request, subscribe } from '../ipc/ipc.js'
import type { NotificationSpec } from '../platform/global.d.js'
import { errorCodeToI18nKey } from '../errors/error-messages.js'
import { getPrefs } from './prefs.js'
import type { NotificationEventPrefs } from './prefs-shape.js'
import { pausedBodyKey, pausedManyBodyKey } from './pausedToast.js'
import { createCoalescer } from './coalesce.js'

interface JoinRequestMessage {
  spaceId: string
  publicKey: string
  displayName: string
  avatar?: string | null
}

interface SpaceMessage {
  spaceId: string
}

interface MemberJoinedMessage {
  spaceId: string
  member: { publicKey: string }
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
  getMember(spaceId: string, publicKey: string): { displayName: string; avatar?: string | null } | null
  getSpaceName(spaceId: string): string
}

type Translate = typeof i18n.t

// One person shared by several spaces arrives and leaves once per space.
const PRESENCE_FORGET_MS = 5 * 60_000
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

function close(id: string): void {
  window.bridge.closeNotification(id).catch((err) => console.error('closing a notification failed:', err))
}

// One notification per burst: `spec` builds it for an episode, with `count` 1 for the first hit.
// The summary reuses its episode's id, so main replaces that episode's notification and no other.
function coalesced<T>(
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

function withIcon(spec: NotificationSpec, avatar: string | null | undefined): NotificationSpec {
  return avatar ? { ...spec, icon: avatar } : spec
}

function startMembership(deps: DispatcherDeps, t: Translate): () => void {
  const open = new Map<string, Set<string>>()
  const alertId = (spaceId: string, publicKey: string) => `join-request:${spaceId}:${publicKey}`
  const resolve = (spaceId: string, publicKey: string) => {
    if (!open.get(spaceId)?.delete(publicKey)) return
    close(alertId(spaceId, publicKey))
  }

  const unsubs = [
    subscribe<JoinRequestMessage>('event:member-join-request', (msg) => {
      if (!getPrefs().events.joinRequests) return
      let shown = open.get(msg.spaceId)
      if (!shown) open.set(msg.spaceId, (shown = new Set()))
      if (shown.has(msg.publicKey)) return
      shown.add(msg.publicKey)
      show(withIcon({
        id: alertId(msg.spaceId, msg.publicKey),
        title: msg.displayName?.trim() || t('notifications.fallbackPeerName'),
        body: t('notifications.joinRequestBody', { space: deps.getSpaceName(msg.spaceId) }),
        payload: { kind: 'join-request', spaceId: msg.spaceId },
      }, msg.avatar))
    }),
    // The pending set changed, possibly on another member's peer: whatever is no longer pending was
    // answered, and its alert has nothing left to ask.
    subscribe<SpaceMessage>('event:join-requests-updated', (msg) => {
      const shown = open.get(msg.spaceId)
      if (!shown || shown.size === 0) return
      request('space:pending-requests', { spaceId: msg.spaceId }).then((rows) => {
        const pending = new Set(rows.map((r) => r.publicKey))
        for (const publicKey of [...shown]) if (!pending.has(publicKey)) resolve(msg.spaceId, publicKey)
      }, (err) => console.error('pending join requests unavailable:', err))
    }),
    subscribe<MemberJoinedMessage>('event:member-joined', (msg) => resolve(msg.spaceId, msg.member.publicKey)),
    subscribe<SpaceMessage>('event:membership-granted', (msg) => {
      if (!getPrefs().events.joinRequests) return
      show({
        id: `membership-granted:${msg.spaceId}`,
        title: t('notifications.membershipGrantedTitle'),
        body: t('notifications.membershipGrantedBody', { space: deps.getSpaceName(msg.spaceId) }),
        payload: { kind: 'membership-granted', spaceId: msg.spaceId },
      })
    }),
    subscribe<SpaceMessage>('event:membership-denied', (msg) => {
      if (!getPrefs().events.joinRequests) return
      show({
        id: `membership-denied:${msg.spaceId}`,
        title: t('notifications.membershipDeniedTitle'),
        body: t('member.membershipDenied', { space: deps.getSpaceName(msg.spaceId) }),
        payload: { kind: 'membership-denied' },
      })
    }),
  ]
  return () => {
    unsubs.forEach((u) => u())
    open.clear()
  }
}

function startActivity(deps: DispatcherDeps, t: Translate): () => void {
  const actorName = (msg: ActivityEvent) => msg.actor?.name?.trim() || t('notifications.fallbackPeerName')
  const avatarOf = (msg: ActivityEvent) => (msg.space && msg.actor?.key ? deps.getMember(msg.space.id, msg.actor.key)?.avatar : null)
  const spaceName = (msg: ActivityEvent) => msg.space?.name || (msg.space ? deps.getSpaceName(msg.space.id) : '')

  const shared = coalesced<ActivityEvent>('newShares', (msg, count, episode) => {
    const space = spaceName(msg)
    const body = count > 1
      ? t('notifications.sharedManyBody', { count, space })
      : msg.kind === NOTIFIABLE_KIND.PEER_SHARE_CREATED
        ? t('notifications.sharedFolderBody', { folder: msg.target?.name ?? '', space })
        : t('notifications.sharedFileBody', { file: basename(msg.target?.name ?? ''), space })
    return withIcon({
      id: `new-shares:${msg.space?.id}:${msg.actor?.key}:${episode}`,
      title: actorName(msg),
      body,
      groupId: `space:${msg.space?.id}`,
      payload: { kind: 'new-shares', spaceId: msg.space?.id ?? '' },
    }, avatarOf(msg))
  })

  const received = coalesced<ActivityEvent>('fileReceived', (msg, count, episode) => withIcon({
    id: `file-received:${msg.space?.id}:${msg.actor?.key}:${episode}`,
    title: actorName(msg),
    body: count > 1
      ? t('notifications.fileReceivedManyBody', { count, space: spaceName(msg) })
      : t('notifications.fileReceivedBody', { file: msg.target?.name ?? '' }),
    groupId: `space:${msg.space?.id}`,
    payload: { kind: 'file-received', spaceId: msg.space?.id ?? '' },
  }, avatarOf(msg)))

  const presenceSeen = new Map<string, number>()
  const onPresence = (msg: ActivityEvent) => {
    const key = `${msg.kind}:${msg.actor?.key}`
    const now = Date.now()
    if (now - (presenceSeen.get(key) ?? -Infinity) < PRESENCE_FORGET_MS) return
    presenceSeen.set(key, now)
    show(withIcon({
      id: `presence:${msg.actor?.key}`,
      title: actorName(msg),
      body: t(msg.kind === NOTIFIABLE_KIND.PEER_BACK ? 'notifications.presenceBackBody' : 'notifications.presenceAwayBody'),
      payload: { kind: 'presence' },
    }, avatarOf(msg)))
  }

  const onMirrorSynced = (msg: ActivityEvent, spaceId: string) => show(withIcon({
    id: `mirror-synced:${spaceId}:${msg.target?.id}:${msg.actor?.key}`,
    title: actorName(msg),
    body: t('notifications.mirrorSyncedBody', { folder: msg.target?.name ?? '' }),
    payload: { kind: 'mirror-synced', spaceId },
  }, avatarOf(msg)))

  const route = (msg: ActivityEvent, spaceId: string, events: NotificationEventPrefs) => {
    switch (msg.kind) {
      case NOTIFIABLE_KIND.PEER_FILE_SHARED:
      case NOTIFIABLE_KIND.PEER_SHARE_CREATED:
        if (events.newShares) shared.hit(`${spaceId}:${msg.actor?.key}`, `${msg.kind}:${msg.target?.id}`, msg)
        return
      case NOTIFIABLE_KIND.SERVE_COMPLETED:
        if (events.fileReceived) received.hit(`${spaceId}:${msg.actor?.key}`, msg.target?.id ?? '', msg)
        return
      case NOTIFIABLE_KIND.MIRROR_PEER_SYNCED:
        if (events.fileReceived) onMirrorSynced(msg, spaceId)
        return
      case NOTIFIABLE_KIND.PEER_BACK:
      case NOTIFIABLE_KIND.PEER_LOST:
        if (events.presence) onPresence(msg)
    }
  }

  const unsub = subscribe<ActivityEvent>('event:activity', (msg) => {
    if (msg.space) route(msg, msg.space.id, getPrefs().events)
  })
  return () => {
    unsub()
    shared.close()
    received.close()
    presenceSeen.clear()
  }
}

function startTransfers(t: Translate): () => void {
  const tErr = i18n.getFixedT(null, 'errors')
  const completed = coalesced<TransferCompleteMessage>('transferComplete', (msg, count, episode) => ({
    id: `transfer-complete:${msg.spaceId}:${episode}`,
    title: t('notifications.transferCompleteTitle'),
    body: count > 1 ? t('notifications.transferCompleteManyBody', { count }) : basename(msg.path),
    groupId: `space:${msg.spaceId}`,
    payload: { kind: 'transfer-complete', spaceId: msg.spaceId, localPath: msg.localPath, path: msg.path },
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
  const paused = coalesced<TransferPausedMessage>('transferPaused', (msg, count, episode) => ({
    id: `transfer-paused:${msg.spaceId}:${pausedBodyKey(msg.reason)}:${episode}`,
    title: t('notifications.transferPausedTitle'),
    body: count > 1 ? t(pausedManyBodyKey(msg.reason), { count }) : t(pausedBodyKey(msg.reason), { file: basename(msg.path) }),
    groupId: `space:${msg.spaceId}`,
    payload: { kind: 'transfer-paused', spaceId: msg.spaceId, path: msg.path },
  }))

  const unsubs = [
    subscribe<TransferCompleteMessage>('event:transfer-complete', (msg) => {
      if (!getPrefs().events.transferComplete || !msg.localPath) return
      completed.hit(msg.spaceId, msg.transferId, msg)
    }),
    subscribe<TransferErrorMessage>('event:transfer-error', (msg) => {
      if (!getPrefs().events.transferError) return
      failed.hit(`${msg.spaceId}:${msg.errorCode ?? ''}`, msg.transferId, msg)
    }),
    subscribe<TransferPausedMessage>('event:transfer-paused', (msg) => {
      if (!getPrefs().events.transferPaused) return
      paused.hit(`${msg.spaceId}:${pausedBodyKey(msg.reason)}`, msg.transferId, msg)
    }),
  ]
  return () => {
    unsubs.forEach((u) => u())
    for (const bursts of [completed, failed, paused]) bursts.close()
  }
}

export function startNotifications(deps: DispatcherDeps): () => void {
  const t = i18n.t.bind(i18n)
  const stops = [startMembership(deps, t), startActivity(deps, t), startTransfers(t)]
  return () => stops.forEach((stop) => stop())
}
