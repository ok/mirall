import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import IconButton from '../primitives/IconButton.js'

// The block every dialog opens with; design.md fixes its anatomy. Two axes are real variation: the
// title is a sentence or a <FilenameTitle> carrying a typed name, and the close button is enabled,
// disabled (an operation is running) or absent (dismissing no longer means anything).
// `descriptionSize` records the split the dialogs already carry; it is not a design rule.
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
