// Connectivity context: projects event:network-status and navigator.onLine into a stable online/connecting/offline state (boot-grace + DHT-failure windows).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { request, subscribe } from '../ipc.js'
import type { CanaryResult, ConnectivityState, NetworkStatus, Reachability } from '../types.js'

interface ConnectionStatusContextValue {
  state: ConnectivityState
  status: NetworkStatus | null
  reachability: Reachability | null
  reconnect: () => Promise<void>
  probeCanary: (opts?: { force?: boolean }) => Promise<CanaryResult | null>
}

const ConnectionStatusContext = createContext<ConnectionStatusContextValue | null>(null)

const BOOT_GRACE_MS = 15000
const DHT_FAILURE_MS = 45000

function deriveState(status: NetworkStatus | null, browserOnline: boolean, now: number): ConnectivityState {
  if (!browserOnline) return 'offline'
  if (!status) return 'online'
  if (status.suspended) return 'offline'

  // dhtReady alone is NOT connectivity — it only means a bootstrap node answered us.
  switch (status.reachability?.verdict) {
    case 'blocked': return 'offline'
    case 'at-risk': return 'connecting'
    case 'healthy': return 'online'
  }

  if (status.dhtReady) return 'online'
  const sinceBoot = status.bootedAt > 0 ? now - status.bootedAt : 0
  if (sinceBoot < BOOT_GRACE_MS) return 'online'
  if (sinceBoot < DHT_FAILURE_MS) return 'connecting'
  return 'offline'
}

interface ProviderProps {
  children: ReactNode
}

export function ConnectionStatusProvider({ children }: ProviderProps) {
  const [status, setStatus] = useState<NetworkStatus | null>(null)
  const [browserOnline, setBrowserOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  )
  // Chromium's net.online, read in main. Only ever used to declare offline: Electron
  // documents `false` as a strong negative and `true` as inconclusive.
  const [netOnline, setNetOnline] = useState<boolean>(true)
  const osOnline = browserOnline && netOnline
  const [stableState, setStableState] = useState<ConnectivityState>('online')
  const recheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    request('network:status:get')
      .then((data) => {
        if (cancelled) return
        const payload = data as NetworkStatus | null | undefined
        if (payload) setStatus(payload)
      })
      .catch(() => {})
    const unsub = subscribe<NetworkStatus>('event:network-status', (msg) => {
      setStatus(msg)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  useEffect(() => {
    const goOnline = () => setBrowserOnline(true)
    const goOffline = () => setBrowserOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  useEffect(() => {
    window.bridge.getNetOnline().then(setNetOnline).catch(() => {})
    return window.bridge.onNetOnlineChange(setNetOnline)
  }, [])

  // NetworkInformation fires on transitions Chromium notices that never cross the
  // online/offline boundary — a good moment to re-probe instead of waiting out the
  // worker's interval. `type` is not exposed on desktop, so this is a trigger, not a signal.
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection
    if (!connection) return
    const onChange = () => { request('network:check-liveness').catch(() => {}) }
    connection.addEventListener('change', onChange)
    return () => connection.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (recheckTimerRef.current) {
      clearTimeout(recheckTimerRef.current)
      recheckTimerRef.current = null
    }

    const now = Date.now()
    setStableState(deriveState(status, osOnline, now))

    if (!status || status.suspended || status.dhtReady || !osOnline) return
    if (status.reachability && status.reachability.verdict !== 'unknown') return
    if (status.bootedAt <= 0) return

    const sinceBoot = now - status.bootedAt
    const nextBoundary = sinceBoot < BOOT_GRACE_MS
      ? BOOT_GRACE_MS - sinceBoot
      : sinceBoot < DHT_FAILURE_MS
        ? DHT_FAILURE_MS - sinceBoot
        : 0
    if (nextBoundary <= 0) return

    recheckTimerRef.current = setTimeout(() => {
      recheckTimerRef.current = null
      setStableState(deriveState(status, osOnline, Date.now()))
    }, nextBoundary + 100)
  }, [status, osOnline])

  useEffect(() => {
    return () => {
      if (recheckTimerRef.current) {
        clearTimeout(recheckTimerRef.current)
        recheckTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    request('network:online-hint', { online: osOnline }).catch(() => {})
    request('network:check-liveness').catch(() => {})
  }, [osOnline])

  const reconnect = useCallback(async () => {
    try {
      await request('network:reconnect')
    } catch {}
  }, [])

  const probeCanary = useCallback(async (opts?: { force?: boolean }) => {
    try {
      return await request('network:probe-canary', { force: !!opts?.force }) as CanaryResult
    } catch {
      return null
    }
  }, [])

  const value = useMemo<ConnectionStatusContextValue>(
    () => ({ state: stableState, status, reachability: status?.reachability ?? null, reconnect, probeCanary }),
    [stableState, status, reconnect, probeCanary],
  )

  return (
    <ConnectionStatusContext.Provider value={value}>
      {children}
    </ConnectionStatusContext.Provider>
  )
}

export function useConnectionStatus(): ConnectionStatusContextValue {
  const ctx = useContext(ConnectionStatusContext)
  if (!ctx) throw new Error('useConnectionStatus must be used within ConnectionStatusProvider')
  return ctx
}
