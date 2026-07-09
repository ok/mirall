export type ToastVariant = 'error' | 'warning' | 'success' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  id?: string
  duration?: number
  action?: ToastAction
}

export interface ToastItem {
  id: string
  variant: ToastVariant
  message: string
  duration: number
  action?: ToastAction
  createdAt: number
}

export interface ToastApi {
  show: (variant: ToastVariant, message: string, opts?: ToastOptions) => string
  dismiss: (id: string) => void
  error: (message: string, opts?: ToastOptions) => string
  warning: (message: string, opts?: ToastOptions) => string
  success: (message: string, opts?: ToastOptions) => string
  info: (message: string, opts?: ToastOptions) => string
}
