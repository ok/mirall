export type ToastVariant = 'error' | 'warning' | 'success' | 'info'

interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  id?: string
  duration?: number
  action?: ToastAction
  // 'keep' leaves a toast already on screen with the same id and text untouched: no remount, no
  // second announcement, its countdown running on. For a fault that repeats once per file.
  whileShown?: 'replace' | 'keep'
}

export interface ToastItem {
  id: string
  // Bumped on every show, replacements included, so a repeat of an id already on screen remounts
  // its toast: the countdown restarts from the full duration and the alert node is announced again.
  seq: number
  variant: ToastVariant
  message: string
  duration: number
  action?: ToastAction
}

export interface ToastApi {
  show: (variant: ToastVariant, message: string, opts?: ToastOptions) => string
  dismiss: (id: string) => void
  error: (message: string, opts?: ToastOptions) => string
  warning: (message: string, opts?: ToastOptions) => string
  success: (message: string, opts?: ToastOptions) => string
  info: (message: string, opts?: ToastOptions) => string
}
