import { useTranslation } from 'react-i18next'
import { RECENT_FACES, type RecipientSummary } from '../../model/file-recipients.js'
import AvatarStack from '../primitives/AvatarStack.js'
import Icon from '../primitives/Icon.js'

interface RecipientsIndicatorProps {
  summary: RecipientSummary
  open: boolean
  onToggle: () => void
  controlsId: string
}

// Who has one of our files, beside its resting pill: the latest recipients by face and how many of
// the space hold the current version. No overflow chip — the count already says it. The row sheds
// in two steps so the file name keeps its room: the faces go first, then the sentence gives way to
// "15/19". The toggle is always named by the whole sentence, which is the one accessible node; the
// visible text is never wrapped. When the one other member has it, the sentence names them.
export default function RecipientsIndicator({ summary, open, onToggle, controlsId }: RecipientsIndicatorProps) {
  const { t } = useTranslation()
  const recent = summary.holders.slice(0, RECENT_FACES)
  const names = recent.map((m) => m.displayName || t('member.unknown')).join(', ')
  const values = { count: summary.count, total: summary.total }
  const sentence = !summary.everyone ? t('file.recipientsOf', values)
    : summary.total === 1 ? t('file.recipientsOnly', { name: summary.holders[0].displayName || t('member.unknown') })
      : t('file.recipientsAll', values)
  return (
    <div className="ml-4 shrink-0 self-center flex items-center justify-end gap-2">
      {!summary.everyone && (
        <AvatarStack
          className="shrink-0 hidden @min-[680px]/row:flex group-hover:[--avatar-ring:var(--color-surface-container-highest)]"
          size="sm"
          surface="surface-container-lowest"
          announce="group"
          label={t('file.recipientsRecent', { names })}
          max={RECENT_FACES}
          avatars={recent.map((m) => ({ key: m.publicKey, src: m.avatar, displayName: m.displayName }))}
        />
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={open ? controlsId : undefined}
        className="flex items-center gap-1 whitespace-nowrap rounded-lg py-1 pl-1.5 pr-0.5 text-[11px] leading-none text-on-surface-variant hover:bg-surface-container-high focus-ring"
      >
        <span className="sr-only">{sentence}</span>
        {summary.everyone && <Icon name="check_circle" size={14} className="text-on-success shrink-0" />}
        <span aria-hidden="true" data-recipients-text="full" className="hidden @min-[560px]/row:inline">{sentence}</span>
        <span aria-hidden="true" data-recipients-text="short" className="tabular-nums @min-[560px]/row:hidden">{t('file.recipientsShort', values)}</span>
        <Icon
          name="chevron_right"
          size={18}
          className={`text-secondary shrink-0 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
        />
      </button>
    </div>
  )
}
