// Toast state and context: id-keyed replace/dedupe, the visible stack (toastStack.js), and
// auto-dismiss timers with pause/resume; exposes window.__toast in dev builds.
//
// A caller that names no id gets one derived from the text (toastKey), so saying the same thing
// twice replaces rather than stacks.
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
import { toastKey } from './toastKey.js'
import { isSticky, pushToast } from './toastStack.js'
import ToastContainer from './ToastContainer.js'

declare global {
  interface Window {
    __toast?: ToastApi
  }
}

const ToastContext = createContext<ToastApi | null>(null)

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
  const pausedRef = useRef<Set<string>>(new Set())
  const seqRef = useRef(0)

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
    pausedRef.current.delete(id)
    setItems((prev) => (prev.some((i) => i.id === id) ? prev.filter((i) => i.id !== id) : prev))
  }, [])

  const scheduleDismiss = useCallback(
    (id: string, duration: number) => {
      if (isSticky(duration)) return
      const timer = setTimeout(() => dismiss(id), duration)
      timersRef.current.set(id, timer)
    },
    [dismiss],
  )

  const show = useCallback(
    (variant: ToastVariant, message: string, opts: ToastOptions = {}): string => {
      const id = opts.id ?? toastKey(variant, message)
      const duration = opts.duration ?? DEFAULT_DURATION
      const item: ToastItem = {
        id,
        seq: ++seqRef.current,
        variant,
        message,
        duration,
        action: opts.action,
      }
      const previous = timersRef.current.get(id)
      if (previous !== undefined) {
        clearTimeout(previous)
        timersRef.current.delete(id)
      }
      pausedRef.current.delete(id)
      setItems((prev) => pushToast(prev, item, pausedRef.current))
      scheduleDismiss(id, duration)
      return id
    },
    [scheduleDismiss],
  )

  const pause = useCallback((id: string) => {
    pausedRef.current.add(id)
    const timer = timersRef.current.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const resume = useCallback(
    (id: string, remaining: number) => {
      pausedRef.current.delete(id)
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
