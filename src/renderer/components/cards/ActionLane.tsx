// The action strip at a file row's right edge: two slots at a constant width, so the status pills
// line up down a list whatever each row offers. Which button sits in which slot is fileRowActions';
// this renders it. The secondary slot shows on row hover or on keyboard focus, and stays in the
// accessibility tree and the Tab order while hidden.
//
// `verbs` is total for every action the row's context can produce, so a row that forgets one fails
// `tsc` instead of rendering a named button that does nothing.
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import { fileRowActions } from '../../model/file-row-action.js'
import type { RowAction, RowActionContext, RowActionId } from '../../model/file-row-action.js'
import type { FileStatus } from '../../types/types.js'

type RowVerb = Exclude<RowActionId, 'busy' | 'download-unavailable'>
/** Only a row whose owner can withdraw one file (a loose file) is offered these. */
type WithdrawVerb = 'unshare' | 'cancel-publish'
type Verbs<V extends RowVerb> = Record<V, () => void>

interface ActionLaneBase {
  row: { status: FileStatus; transferId?: string }
}
interface WithdrawingLaneProps extends ActionLaneBase {
  context: RowActionContext & { ownerFileVerbs: true }
  verbs: Verbs<RowVerb>
}
interface FolderLaneProps extends ActionLaneBase {
  context: RowActionContext & { ownerFileVerbs: false }
  verbs: Verbs<Exclude<RowVerb, WithdrawVerb>>
}
export type ActionLaneProps = WithdrawingLaneProps | FolderLaneProps

export default function ActionLane({ row, context, verbs }: ActionLaneProps) {
  const { t } = useTranslation()
  const { primary, secondary } = fileRowActions(row, context)
  const run: Partial<Verbs<RowVerb>> = verbs
  return (
    <div className="flex items-center gap-1 shrink-0">
      <ActionSlot action={secondary} run={run} t={t} revealOnHover />
      <ActionSlot action={primary} run={run} t={t} revealOnHover={false} />
    </div>
  )
}

interface ActionSlotProps {
  action: RowAction | null
  run: Partial<Verbs<RowVerb>>
  t: TFunction
  revealOnHover: boolean
}

function ActionSlot({ action, run, t, revealOnHover }: ActionSlotProps) {
  if (!action) return <div className="w-10 h-10" />
  const label = t(action.labelKey)
  if (action.id === 'busy') {
    return (
      <span role="status" aria-live="polite" className="w-10 h-10 flex items-center justify-center">
        <Icon name={action.icon} className="text-on-surface-variant animate-pulse" />
        <span className="sr-only">{label}</span>
      </span>
    )
  }
  const verb = action.id === 'download-unavailable' ? undefined : run[action.id]
  return (
    <IconButton
      icon={action.icon}
      iconSize={22}
      iconClassName="text-secondary"
      variant={action.tone}
      // Disabled when nothing runs it, so a control never claims an action it cannot take.
      disabled={action.disabled || !verb}
      onClick={verb && (() => verb())}
      ariaLabel={label}
      title={label}
      className={revealOnHover ? 'opacity-0 group-hover:opacity-100 focus:opacity-100' : undefined}
    />
  )
}
