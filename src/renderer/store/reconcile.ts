import { subscribe } from '../ipc.js'
import { invalidate, refetchQuery, setQueryData } from './query-store.js'
import { SPACES_SCOPES } from './scopes.js'
import type { ScopePattern } from '../../shared/contract/scope.js'
import type { RequestName } from '../../shared/contract/requests.js'

// The app's worker-event → store subscriptions, each installed exactly once. A subscription that
// WRITES the store belongs here rather than in a hook: a hook runs once per mounted consumer, so
// the same event would write the same entry N times, and each write publishes a new object that
// defeats the store's identity check and re-renders every subscriber again.

// ONE reconcile subscription for the whole app. Nine hooks each held their own and each ran
// scopeMatches; the store now does it once and invalidates by predicate.
export function installReconcileBridge(): () => void {
  return subscribe<{ scope?: ScopePattern }>('event:reconcile', (msg) => {
    if (msg.scope) invalidate(msg.scope)
  })
}

interface RootsStatus { unavailable?: string[] }

const NO_ROOTS: string[] = []
const list = (res: RootsStatus | undefined) => (Array.isArray(res?.unavailable) ? res.unavailable : NO_ROOTS)

const reread = (type: RequestName, scopes: ScopePattern[] | null) => {
  void refetchQuery(type, {}, scopes).catch(() => undefined)
}

// Every worker event that PUSHES a value into the store, or re-reads one, subscribed once for the
// app. Two of these used to live in the hooks that read them, and both hooks have several mounted
// consumers: useDownloadRootStatus two (Storage settings and the toast bridge), useSpaces five.
// One event therefore wrote the same entry once per mount — each write publishing a new object
// that defeats the store's identity check and re-renders every subscriber again — and each
// membership signal fired N refetches that abandoned one another's in-flight read.
export function installPushBridges(): () => void {
  const unsubs = [
    // The whole answer rides the event, so it is pushed rather than poked.
    subscribe<RootsStatus>('event:download-roots-status', (msg) => {
      setQueryData<RootsStatus>('downloads:roots-status', {}, { unavailable: list(msg) })
    }),
    // The worker probes download roots on a 60 s tick, so a download that just failed on a gone
    // folder would otherwise sit behind a generic error for up to a minute. The failure itself is
    // the signal to re-probe now.
    subscribe<{ errorCode?: string }>('event:transfer-error', (msg) => {
      if (msg?.errorCode !== 'TRANSFER_DEST_UNAVAILABLE') return
      reread('downloads:roots-status', null)
    }),
    // A push, not an answer to a fetch: it lands in the same entry a read would fill, so the two
    // cannot disagree.
    subscribe<{ spaces?: unknown }>('event:state', (msg) => {
      if (msg.spaces) setQueryData('spaces:list', {}, msg.spaces, SPACES_SCOPES)
    }),
    // One-shot user-level signals rather than view pokes, which is why they stay named events
    // instead of riding event:reconcile.
    ...['event:membership-granted', 'event:membership-denied', 'event:membership-creator-divergence']
      .map((name) => subscribe(name, () => reread('spaces:list', SPACES_SCOPES))),
  ]
  return () => { for (const off of unsubs) off() }
}
