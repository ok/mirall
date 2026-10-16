// A row's box in the selection column. Positioned against the row's left edge, so a row nested
// `depth` levels deep (each FolderTree level is pl-6) still lands at the column's one x.
import Checkbox, { type CheckboxProps } from '../primitives/Checkbox.js'

/** The column: a 40px hit area plus the controls row's 12px gap, which the scroll pane's pl-14 matches. */
const SELECTION_GUTTER = 52
const INDENT = 24

export default function SelectBox({ depth, ...box }: { depth: number } & CheckboxProps) {
  return (
    <div
      className="absolute inset-y-0 flex items-center justify-center w-10 animate-[select-box-in_200ms_ease-out] motion-reduce:animate-none"
      style={{ left: -(SELECTION_GUTTER + depth * INDENT) }}
    >
      <Checkbox {...box} />
    </div>
  )
}
