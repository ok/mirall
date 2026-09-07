import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import IconButton from '../primitives/IconButton.js'

// The block every dialog opens with, and the one design.md fixes the anatomy of. Seventeen dialogs
// wrote it out by hand: two drifted off the documented padding, one titled itself with an <h2>, and
// twelve were missing the gap that keeps a long title off the close button.
//
// Two axes are real variation and stay props. The title is either a plain sentence or a
// <FilenameTitle> carrying a name someone typed, and the close button can be disabled (an operation
// is running) or absent (the dialog has passed the point where dismissing it means anything). The
// description's two sizes are NOT a rule — nothing separates the seven base ones from the six small
// ones — so the prop records the split rather than restyling thirteen dialogs inside a refactor.
type ModalHeaderProps = {
  description?: ReactNode
  descriptionSize?: 'base' | 'sm'
  descriptionId?: string
  onClose?: () => void
  closeDisabled?: boolean
  className?: string
} & (
  | { title: string; titleNode?: never }
  | { title?: never; titleNode: ReactNode }
)

export default function ModalHeader({
  title,
  titleNode,
  description,
  descriptionSize = 'base',
  descriptionId,
  onClose,
  closeDisabled,
  className,
}: ModalHeaderProps) {
  const { t } = useTranslation()
  return (
    <div className={`px-10 pt-10 pb-6${className ? ` ${className}` : ''}`}>
      {/* gap-3 unconditionally: a title long enough to reach the close button is one locale away on
          every dialog, not only on the four that interpolate a file name. */}
      <div className="flex justify-between items-start mb-2 gap-3">
        {titleNode ?? (
          <h1 className="font-headline text-2xl font-extrabold text-accent tracking-tight">{title}</h1>
        )}
        {onClose && (
          <IconButton
            icon="close"
            onClick={onClose}
            ariaLabel={t('actions.close')}
            disabled={closeDisabled}
            iconClassName="text-secondary"
          />
        )}
      </div>
      {description && (
        <p
          id={descriptionId}
          className={`text-on-surface-variant font-medium${descriptionSize === 'sm' ? ' text-sm' : ''}`}
        >
          {description}
        </p>
      )}
    </div>
  )
}
