import FieldLabel from '../primitives/FieldLabel.js'
import InlineError from '../primitives/InlineError.js'
import PathRow from './PathRow.js'

interface MountPathFieldProps {
  id: string
  label: string
  path: string
  error: string | null
  onBrowse: () => void
  onCommit: (path: string) => void
}

export default function MountPathField({ id, label, path, error, onBrowse, onCommit }: MountPathFieldProps) {
  return (
    <div className="space-y-3">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <PathRow id={id} path={path} onAction={onBrowse} onCommit={onCommit} ariaDescribedBy={error ? `${id}-error` : undefined} />
      {error && <InlineError id={`${id}-error`} size="xs" className="px-1">{error}</InlineError>}
    </div>
  )
}
