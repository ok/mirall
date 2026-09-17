// Advanced details: the raw connection values, one screen below Network status. Read-only apart
// from the bulk copy, which is why it is a destination rather than a disclosure on a page whose job
// is to tell the user whether their network works.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { advancedSections, advancedDetailsText } from '../model/advanced-details.js'
import type { AdvancedRow } from '../model/advanced-details.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useConnectionStatus } from '../hooks/useConnectionStatus.js'
import Button from '../components/primitives/Button.js'
import Icon from '../components/primitives/Icon.js'
import PageHeader from '../components/layout/PageHeader.js'
import { Section, Field, MaskedField } from '../components/network/StatusRows.js'

interface Props {
  onBack: () => void
}

interface BootstrapListProps {
  label: string
  items: string[]
}

function BootstrapList({ label, items }: BootstrapListProps) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) {
    return <div className="px-6 py-4 text-sm text-on-surface-variant">{label}</div>
  }
  return (
    <div className="px-6 py-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-sm font-medium text-accent flex items-center gap-2 focus-ring rounded-sm"
      >
        <Icon name={open ? 'expand_more' : 'chevron_right'} size={18} className="text-outline" />
        {label}
      </button>
      {open && (
        <ul className="mt-3 space-y-1 font-mono text-xs text-on-surface-variant">
          {items.map((entry) => (
            <li key={entry} className="break-all">{entry}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AdvancedRowView({ row }: { row: AdvancedRow }) {
  if (row.kind === 'bootstrap') return <BootstrapList label={row.value} items={row.items ?? []} />
  if (row.kind === 'masked') {
    return <MaskedField label={row.label} value={row.value || null} visibleSuffix={row.visibleSuffix} />
  }
  return <Field label={row.label} value={row.value} mono={row.kind === 'mono'} positive={row.positive} />
}

export default function NetworkAdvancedScreen({ onBack }: Props) {
  const { t } = useTranslation()
  const { status } = useConnectionStatus()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const [copied, setCopied] = useState(false)
  const sections = status ? advancedSections(status, Date.now(), t) : []

  function handleCopy() {
    navigator.clipboard.writeText(advancedDetailsText(sections))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      ref={ref}
      className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader
          title={t('networkStatus.advanced.title')}
          subtitle={t('networkStatus.advanced.intro')}
          onBack={onBack}
        />

        <div className="space-y-10">
          {sections.length > 0 && (
            <div className="flex items-center justify-end gap-2">
              <p role="status" aria-live="polite" className="text-xs text-on-surface-variant">
                {copied ? t('actions.copied') : ''}
              </p>
              <Button variant="secondary" icon="content_copy" onClick={handleCopy}>
                {t('networkStatus.advanced.copyAll')}
              </Button>
            </div>
          )}

          {sections.map((section) => (
            <Section key={section.key} title={section.title}>
              {section.rows.map((row) => <AdvancedRowView key={row.label} row={row} />)}
            </Section>
          ))}
        </div>
      </div>
    </div>
  )
}
