// Base dialog shell: react-aria focus trap, Escape to dismiss, Cmd/Ctrl+Enter to
// confirm, and a window-level event that closes every open modal at once.
import { forwardRef, useEffect, useRef, type ForwardedRef, type KeyboardEvent, type ReactNode } from 'react'
import { useDialog, FocusScope } from 'react-aria'
import CrystalBackdrop from '../widgets/CrystalBackdrop.js'

export const CLOSE_MODALS_EVENT = 'mirall:close-modals'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm?: () => void
  isDismissable?: boolean
  ariaLabel?: string
  panelClassName?: string
  children: ReactNode
}

interface ModalContentsProps extends ModalProps {
  externalRef: ForwardedRef<HTMLDivElement>
}

const DEFAULT_PANEL = 'glass-modal w-full max-w-xl rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative'

const Modal = forwardRef<HTMLDivElement, ModalProps>(function Modal(props, externalRef) {
  if (!props.isOpen) return null
  return <ModalContents {...props} externalRef={externalRef} />
})

function ModalContents({
  onClose,
  onConfirm,
  isDismissable = true,
  ariaLabel,
  panelClassName,
  children,
  externalRef,
}: ModalContentsProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const { dialogProps } = useDialog({ 'aria-label': ariaLabel }, contentRef)

  useEffect(() => {
    const handler = () => onClose()
    window.addEventListener(CLOSE_MODALS_EVENT, handler)
    return () => window.removeEventListener(CLOSE_MODALS_EVENT, handler)
  }, [onClose])

  function setWrapperRef(node: HTMLDivElement | null) {
    if (typeof externalRef === 'function') externalRef(node)
    else if (externalRef) externalRef.current = node
  }

  function onWrapperKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape' && isDismissable) {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'Enter' && onConfirm) {
      const isMac = window.bridge.getPlatform() === 'darwin'
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (mod) {
        e.preventDefault()
        onConfirm()
      }
    }
  }

  function onBackdropClick() {
    if (isDismissable) onClose()
  }

  return (
    <div
      ref={setWrapperRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
    >
      <CrystalBackdrop onClick={onBackdropClick} />
      <FocusScope contain restoreFocus autoFocus>
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the dialog owns its Escape / Cmd+Enter keyboard handling */}
        <div
          {...dialogProps}
          role="dialog"
          aria-modal="true"
          onKeyDown={onWrapperKeyDown}
          ref={contentRef}
          className={panelClassName ?? DEFAULT_PANEL}
        >
          {children}
        </div>
      </FocusScope>
    </div>
  )
}

export default Modal
