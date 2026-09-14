import { useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../primitives/Modal.js'
import ModalHeader from '../layout/ModalHeader.js'
import ModalFooter from '../layout/ModalFooter.js'
import Button from '../primitives/Button.js'

// The "are you sure" dialog for an action that takes something away. `role="alertdialog"` and the
// body paragraph it points `aria-describedby` at are the two halves of one contract: the role makes
// a screen reader read the consequence before the buttons, and it has nothing to read without the
// description. Neither is optional, which is why neither is a prop.
interface ConfirmDestructiveModalProps {
  isOpen: boolean
  // The dialog's accessible name. `titleNode` renders in its place when the name needs its own
  // typography — a filename that must break on the extension rather than mid-word.
  title: string
  titleNode?: ReactNode
  body: ReactNode
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void
  // While set, the dialog cannot be dismissed: the action is running and there is nothing to go
  // back to. It is also what disables both buttons.
  busy?: boolean
  // A notice that sits between the body and the buttons — a consequence the body sentence does not
  // carry, such as a restart.
  children?: ReactNode
}

export default function ConfirmDestructiveModal({
  isOpen, title, titleNode, body, confirmLabel, onClose, onConfirm, busy, children,
}: ConfirmDestructiveModalProps) {
  const { t } = useTranslation()
  const bodyId = useId()
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      isDismissable={!busy}
      role="alertdialog"
      ariaDescribedBy={bodyId}
      ariaLabel={title}
      panelClassName="glass-modal w-full max-w-md rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative"
    >
      <>
        {titleNode
          ? <ModalHeader titleNode={titleNode} onClose={onClose} closeDisabled={busy} />
          : <ModalHeader title={title} onClose={onClose} closeDisabled={busy} />}
        <div className="px-10 pb-10 space-y-6">
          <p id={bodyId} className="text-on-surface-variant font-medium">{body}</p>
          {children}
          <ModalFooter layout="split">
            <Button type="button" variant="secondary" autoFocus onClick={onClose} disabled={busy} className="h-14">
              {t('actions.cancel')}
            </Button>
            <Button type="button" variant="danger" onClick={onConfirm} disabled={busy} className="h-14">
              {confirmLabel}
            </Button>
          </ModalFooter>
        </div>
      </>
    </Modal>
  )
}
