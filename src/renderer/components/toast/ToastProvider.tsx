// Toast state and context: id-keyed replace/dedupe, a capped visible stack, and
// auto-dismiss timers with pause/resume; exposes window.__toast in dev builds.
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
import type { ToastApi, ToastItem, ToastOptions, ToastVariant } from './types.js'
import ToastContainer from './ToastContainer.js'

declare global {
  interface Window {
    __toast?: ToastApi
  }
}

const ToastContext = createContext<ToastApi | null>(null)

const MAX_VISIBLE = 4
const DEFAULT_DURATION = 5000
const MIN_RESUME_DURATION = 1000

function isDevBuild(): boolean {
  return window.bridge?.isDev?.() === true
}

interface Props {
  children: ReactNode
}

export function ToastProvider({ children }: Props) {
  const [items, setItems] = useState<ToastItem[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
    setItems((prev) => prev.filter((i) => i.id !== id))
  }, [])

  const scheduleDismiss = useCallback(
    (id: string, duration: number) => {
      if (duration <= 0) return
      const timer = setTimeout(() => dismiss(id), duration)
      timersRef.current.set(id, timer)
    },
    [dismiss],
  )

  const show = useCallback(
    (variant: ToastVariant, message: string, opts: ToastOptions = {}): string => {
      const id = opts.id ?? `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const duration = opts.duration ?? DEFAULT_DURATION
      const item: ToastItem = {
        id,
        variant,
        message,
        duration,
        action: opts.action,
        createdAt: Date.now(),
      }
      const previous = timersRef.current.get(id)
      if (previous !== undefined) {
        clearTimeout(previous)
        timersRef.current.delete(id)
      }
      setItems((prev) => {
        const without = prev.filter((i) => i.id !== id)
        const next = [...without, item]
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next
      })
      scheduleDismiss(id, duration)
      return id
    },
    [scheduleDismiss],
  )

  const pause = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const resume = useCallback(
    (id: string, remaining: number) => {
      scheduleDismiss(id, Math.max(remaining, MIN_RESUME_DURATION))
    },
    [scheduleDismiss],
  )

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      error: (message, opts) => show('error', message, opts),
      warning: (message, opts) => show('warning', message, opts),
      success: (message, opts) => show('success', message, opts),
      info: (message, opts) => show('info', message, opts),
    }),
    [show, dismiss],
  )

  useEffect(() => {
    if (!isDevBuild()) return
    window.__toast = api
    return () => {
      delete window.__toast
    }
  }, [api])

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastContainer items={items} onDismiss={dismiss} onPause={pause} onResume={resume} />
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
