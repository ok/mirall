// What a control a restore may hold needs: whether it is held, and the attributes that say why. The
// reason is spoken from the restore banner's element (or one the caller renders) and shown as the
// native tooltip; a held control stays focusable and ignores activation.
import { useTranslation } from 'react-i18next'

export const HELD_REASON_ID = 'restore-held-reason'

export function useHeldControl(held: boolean, reasonId: string = HELD_REASON_ID) {
  const { t } = useTranslation()
  return {
    held,
    reason: t('restore.heldReason'),
    attrs: held ? { ariaDisabled: true, ariaDescribedBy: reasonId, title: t('restore.heldReason') } : {},
    guard: (fn: () => void) => () => { if (!held) fn() },
  }
}
