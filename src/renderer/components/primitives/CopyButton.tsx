import { useTranslation } from 'react-i18next'
import { useClipboardCopy } from '../../hooks/useClipboardCopy.js'
import Icon from './Icon.js'

interface CopyButtonProps {
  value: string
  className?: string
  // Shows "Copy" / "Copied!" beside the icon; the caller's className then styles the whole button.
  showLabel?: boolean
}

export default function CopyButton({ value, className = '', showLabel = false }: CopyButtonProps) {
  const { t } = useTranslation()
  const { copied, copy } = useClipboardCopy()

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    copy(value)
  }

  const label = copied ? t('actions.copied') : t('actions.copy')
  const icon = copied ? 'check' : 'content_copy'

  return (
    <>
      {showLabel ? (
        <button type="button" onClick={handleClick} className={className}>
          <Icon name={icon} size={14} />
          {label}
        </button>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          aria-label={label}
          title={label}
          className={`shrink-0 inline-flex items-center justify-center rounded-sm focus-ring ${className}`}
        >
          <Icon name={icon} size={16} className="text-outline" />
        </button>
      )}
      <span role="status" aria-live="polite" className="sr-only">{copied ? t('actions.copied') : ''}</span>
    </>
  )
}
