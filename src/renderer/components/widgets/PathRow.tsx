import { useTranslation } from 'react-i18next'
import FilePath from './FilePath.js'

interface PathRowProps {
  path: string | null
  /** Shown in place of the path when there is none yet. Defaults to the browse hint. */
  placeholder?: string
  /** Omit `onAction` for a display-only row — the field keeps its shape, the button is absent. */
  actionLabel?: string
  onAction?: () => void
  ariaDescribedBy?: string
}

// One filesystem path, presented the same way everywhere it appears in a modal: the path in a
// filled field, with an optional button beside it that re-picks it. Add Folder, Mirror to Disk and
// Edit Folder all show the same thing and had drifted — two of them shared this markup verbatim
// while the third rendered a bare line of text, so the same fact looked like a different kind of
// thing depending on how you arrived at it.
//
// Display-only keeps the field rather than falling back to bare text: a path is a value either
// way, and the button's presence is what says whether you can change it.
export default function PathRow({ path, placeholder, actionLabel, onAction, ariaDescribedBy }: PathRowProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3">
      <div className="flex-grow flex items-center bg-surface-container-low px-5 py-3.5 rounded-xl min-w-0">
        {path ? (
          <FilePath path={path} className="flex-1 text-sm text-accent font-medium" />
        ) : (
          <span className="text-sm text-outline/70 italic">{placeholder ?? t('addFolder.browsePlaceholder')}</span>
        )}
      </div>
      {onAction && (
        <button
          type="button"
          onClick={onAction}
          aria-describedby={ariaDescribedBy}
          className="shrink-0 bg-surface-container-high dark:bg-surface-container-highest text-accent rounded-xl px-5 py-3.5 font-headline font-bold text-sm hover:bg-surface-container-highest dark:hover:bg-surface-container active:scale-95 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
        >
          {actionLabel ?? t('addFolder.browseHint')}
        </button>
      )}
    </div>
  )
}
