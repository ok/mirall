// The action strip at a file row's right edge: two slots at a constant width, so the status pills
// line up down a list whatever each row offers. Which button sits in which slot is fileRowActions';
// this renders it. The secondary slot shows on row hover or on keyboard focus, and stays in the
// accessibility tree and the Tab order while hidden. A status change swaps the slots' controls
// under the user's hands (Download to… becomes Pause), so focus held by a control that goes moves
// to the primary slot's new one, or to the lane while it offers none.
//
// `verbs` is total for every action the row's context can produce, so a row that forgets one fails
// `tsc` instead of rendering a named button that does nothing. Download opens the Download-to menu
// when the listing hands one down; the folder picked there is the one the download goes to.
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Icon from '../primitives/Icon.js'
import IconButton from '../primitives/IconButton.js'
import ActionMenu from '../primitives/ActionMenu.js'
import { useKeepFocus } from '../../hooks/useKeepFocus.js'
import { fileRowActions } from '../../model/file-row-action.js'
import type { RowAction, RowActionContext, RowActionId } from '../../model/file-row-action.js'
import type { DownloadMenu } from '../../hooks/useDownloadTo.js'
import type { FileStatus } from '../../types/types.js'

type RowVerb = Exclude<RowActionId, 'busy' | 'download-unavailable'>
/** Only a row whose owner can withdraw one file (a loose file) is offered these. */
type WithdrawVerb = 'unshare' | 'cancel-publish'
type Verbs<V extends RowVerb> = Record<Exclude<V, 'download'>, () => void> & { download: (folder?: string) => void }

interface ActionLaneBase {
  row: { status: FileStatus; transferId?: string }
  downloadMenu?: DownloadMenu
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

export default function ActionLane({ row, context, verbs, downloadMenu }: ActionLaneProps) {
  const { t } = useTranslation()
  const { primary, secondary } = fileRowActions(row, context)
  const run: Partial<Verbs<RowVerb>> = verbs
  // The primary slot is the lane's last control.
  const { ref, onFocus, onBlur } = useKeepFocus<HTMLDivElement>('last')
  return (
    <div ref={ref} tabIndex={-1} onFocus={onFocus} onBlur={onBlur} className="flex items-center gap-1 shrink-0 rounded-full focus-ring">
      <ActionSlot action={secondary} run={run} t={t} revealOnHover downloadMenu={downloadMenu} />
      <ActionSlot action={primary} run={run} t={t} revealOnHover={false} downloadMenu={downloadMenu} />
    </div>
  )
}

interface ActionSlotProps {
  action: RowAction | null
  run: Partial<Verbs<RowVerb>>
  t: TFunction
  revealOnHover: boolean
  downloadMenu?: DownloadMenu
}

function ActionSlot({ action, run, t, revealOnHover, downloadMenu }: ActionSlotProps) {
  if (!action) return <div className="w-10 h-10" />
  const label = t(action.labelKey)
  const download = run.download
  if (action.menu && downloadMenu && download) {
    return (
      <ActionMenu triggerVariant="subtle" icon={action.icon} label={label} title={label} {...downloadMenu(download)} />
    )
  }
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
