// Base dialog shell: react-aria focus trap, and the one place the dialog keyboard contract lives —
// Escape to dismiss, Enter (plain, or Cmd/Ctrl+Enter from a textarea) to confirm. See modalKeys.ts.
// Also owns the window-level event that closes every open modal at once.
import { forwardRef, useEffect, useRef, type ForwardedRef, type KeyboardEvent, type ReactNode } from 'react'
import { useDialog, FocusScope } from 'react-aria'
import CrystalBackdrop from '../widgets/CrystalBackdrop.js'
import { isMac } from '../../keyboard/accelerator.js'
import { describeModalKeyEvent, modalKeyAction } from './modalKeys.js'

export const CLOSE_MODALS_EVENT = 'mirall:close-modals'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  // Supplying this is what makes Enter confirm. A destructive dialog deliberately omits it: nothing
  // that deletes, removes or leaves may fire from a keypress the person did not aim at a button.
  onConfirm?: () => void
  isDismissable?: boolean
  ariaLabel?: string
  // 'alertdialog' is for the destructive confirms. It REQUIRES ariaDescribedBy: react-aria
  // generates a description id for that role, and without an element carrying it the dialog would
  // point aria-describedby at nothing.
  role?: 'dialog' | 'alertdialog'
  ariaDescribedBy?: string
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
  role = 'dialog',
  ariaDescribedBy,
  panelClassName,
  children,
  externalRef,
}: ModalContentsProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const { dialogProps } = useDialog(
    { 'aria-label': ariaLabel, 'aria-describedby': ariaDescribedBy, role },
    contentRef,
  )

  useEffect(() => {
    // A dialog that refuses Escape and the backdrop refuses this too: a global hotkey must not tear
    // down a modal that is holding a running operation on screen.
    const handler = () => { if (isDismissable) onClose() }
    window.addEventListener(CLOSE_MODALS_EVENT, handler)
    return () => window.removeEventListener(CLOSE_MODALS_EVENT, handler)
  }, [onClose, isDismissable])

  function setWrapperRef(node: HTMLDivElement | null) {
    if (typeof externalRef === 'function') externalRef(node)
    else if (externalRef) externalRef.current = node
  }

  function onWrapperKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const action = modalKeyAction(describeModalKeyEvent(e), {
      isDismissable,
      hasConfirm: onConfirm !== undefined,
      isMac: isMac(),
    })
    if (action === 'dismiss') {
      e.stopPropagation()
      onClose()
      return
    }
    if (action === 'confirm') {
      e.preventDefault()
      e.stopPropagation()
      onConfirm?.()
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
      {/* No `autoFocus`: it lands on the first tabbable element, which in a dialog whose header
          carries the ✕ is the close button — so Enter used to cancel. Without it, a field with its
          own `autoFocus` still claims focus at commit, and useDialog falls back to focusing the
          panel, which is what announces the dialog and lets Enter reach the handler below. */}
      <FocusScope contain restoreFocus>
        <div
          {...dialogProps}
          /* dialogProps already carries the role; spelling it out is what tells the a11y lint this
             is a dialog and not a static div with a key handler bolted on. */
          role={role}
          aria-modal="true"
          onKeyDown={onWrapperKeyDown}
          ref={contentRef}
          className={`${panelClassName ?? DEFAULT_PANEL} focus:outline-none`}
        >
          {children}
        </div>
      </FocusScope>
    </div>
  )
}

export default Modal
