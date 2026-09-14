import FieldLabel from '../primitives/FieldLabel.js'
import InlineError from '../primitives/InlineError.js'
import PathRow from './PathRow.js'

interface MountPathFieldProps {
  id: string
  label: string
  path: string
  error: string | null
  onBrowse: () => void
}

// The label is a <span> carrying an id rather than a <label>: PathRow's action is a button, not a
// form control, so the association goes through aria-describedby.
export default function MountPathField({ id, label, path, error, onBrowse }: MountPathFieldProps) {
  return (
    <div className="space-y-3">
      <FieldLabel id={id}>{label}</FieldLabel>
      <PathRow path={path} onAction={onBrowse} ariaDescribedBy={error ? `${id} ${id}-error` : id} />
      {error && <InlineError id={`${id}-error`} size="xs" className="px-1">{error}</InlineError>}
    </div>
  )
}
