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
      <span id={id} className="block font-headline text-sm font-bold text-accent px-1">{label}</span>
      <PathRow path={path} onAction={onBrowse} ariaDescribedBy={error ? `${id} ${id}-error` : id} />
      {error && <p id={`${id}-error`} role="alert" className="text-xs text-error px-1">{error}</p>}
    </div>
  )
}
