import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon.js'

interface CopyButtonProps {
  value: string
  className?: string
}

export default function CopyButton({ value, className = '' }: CopyButtonProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const label = copied ? t('actions.copied') : t('actions.copy')

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        aria-label={label}
        title={label}
        className={`shrink-0 inline-flex items-center justify-center rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${className}`}
      >
        <Icon name={copied ? 'check' : 'content_copy'} size={16} className="text-outline" />
      </button>
      <span role="status" aria-live="polite" className="sr-only">{copied ? t('actions.copied') : ''}</span>
    </>
  )
}
