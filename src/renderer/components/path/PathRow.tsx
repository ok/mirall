import { useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import CopyButton from '../primitives/CopyButton.js'
import { FIELD_FILL, useFieldFill } from '../primitives/FieldGround.js'
import { FIELD_PLACEHOLDER } from '../primitives/TextField.js'

interface PathRowBase {
  /** The input's id: the field's `<label htmlFor>` points here. */
  id: string
  path: string | null
  /**
   * A path exists but its text has not arrived yet. Distinct from having none: the field says so
   * instead of offering a first pick, and the button already reads as a re-pick, so the label does
   * not flip once the read lands.
   */
  loading?: boolean
  /** For a field named by a heading rather than a `<label>`. */
  ariaLabelledBy?: string
  ariaDescribedBy?: string
}

interface EditablePath {
  /** Opens the folder picker. */
  onAction: () => void
  /** Takes a typed or pasted path; the caller checks it exactly as it checks a picked one. */
  onCommit: (path: string) => void
  /** What the path is, when one page shows several rows: the button's name says it after its label. */
  subject?: string
  /** The field is read-only and the button does nothing while the owner is busy; both stay focusable. */
  actionDisabled?: boolean
  /** Forwarded to the button, for callers that must hand focus back to it. */
  actionRef?: Ref<HTMLButtonElement>
}

interface FixedPath {
  onAction?: never
  onCommit?: never
  subject?: never
  actionDisabled?: never
  actionRef?: never
}

type PathRowProps = PathRowBase & (EditablePath | FixedPath)

// One filesystem path, presented the same way everywhere: a filled text field. An editable path
// has a button beside it that re-picks it, and takes a typed or pasted path on Enter or blur — never
// per keystroke, since every take runs a filesystem check or applies a setting. While an edit is
// pending, Enter takes it and Escape reverts it instead of confirming or dismissing the dialog. A
// fixed path is a read-only field with Copy at its end; the missing button is what says it cannot
// change. The button label follows the state, not the caller: nothing picked is "Browse…", a path
// (or one still loading) is "Change". A field without focus shows the end of its path, so the
// folder's own name stays visible.
export default function PathRow(props: PathRowProps) {
  const { id, path, loading = false, ariaLabelledBy, ariaDescribedBy, onAction, onCommit, subject, actionDisabled = false, actionRef } = props
  const { t } = useTranslation()
  const fill = useFieldFill()
  const inputRef = useRef<HTMLInputElement>(null)
  const shown = path ?? ''
  const [draft, setDraft] = useState(shown)
  const [synced, setSynced] = useState(shown)
  // The last path handed to onCommit, so the blur after an Enter does not take it again. Enter itself
  // always takes: pressing it again is how a refused path is retried.
  const taken = useRef<string | null>(null)
  if (synced !== shown) {
    setSynced(shown)
    setDraft(shown)
    taken.current = null
  }
  const editable = onCommit !== undefined
  const readOnly = !editable || actionDisabled || loading

  // Shown from its end whenever the text or the field's width changes, or the font lands — each moves
  // where the end is. A focused field is the user's to scroll.
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    const showEnd = () => {
      if (document.activeElement !== input) input.scrollLeft = input.scrollWidth
    }
    showEnd()
    const observer = new ResizeObserver(showEnd)
    observer.observe(input)
    document.fonts.addEventListener('loadingdone', showEnd)
    return () => {
      observer.disconnect()
      document.fonts.removeEventListener('loadingdone', showEnd)
    }
  }, [shown])

  function take(again: boolean) {
    const next = draft.trim()
    if (!onCommit || readOnly) return
    if (!next || next === shown) {
      setDraft(shown)
      return
    }
    if (!again && next === taken.current) return
    taken.current = next
    onCommit(next)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (draft === shown) return
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      take(true)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setDraft(shown)
      taken.current = null
    }
  }

  function handleBlur() {
    take(false)
    const input = inputRef.current
    if (input) input.scrollLeft = input.scrollWidth
  }

  return (
    <div className="flex items-center gap-3">
      <div className="relative flex-grow min-w-0">
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={draft}
          readOnly={readOnly}
          spellCheck={false}
          autoComplete="off"
          placeholder={loading ? t('pathField.loading') : undefined}
          title={shown || undefined}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          className={`w-full ${FIELD_FILL[fill]} border-none focus-ring rounded-xl px-5 py-3.5 font-mono text-sm text-accent font-medium ${FIELD_PLACEHOLDER}${editable ? '' : ' pr-12'}`}
        />
        {!editable && shown && (
          <CopyButton value={shown} className="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg hover:bg-surface-control" />
        )}
      </div>
      {onAction && (
        <button
          ref={actionRef}
          type="button"
          onClick={actionDisabled ? undefined : onAction}
          aria-label={subject ? t(path || loading ? 'pathField.changeSubject' : 'pathField.browseSubject', { subject }) : undefined}
          aria-describedby={ariaDescribedBy}
          aria-disabled={actionDisabled || undefined}
          className="shrink-0 bg-surface-control text-accent rounded-xl px-5 py-3.5 font-headline font-bold text-sm hover:bg-surface-control-hover active:scale-95 transition-all focus-ring aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
        >
          {path || loading ? t('actions.change') : t('pathField.browse')}
        </button>
      )}
    </div>
  )
}
