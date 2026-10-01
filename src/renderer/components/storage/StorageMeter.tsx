// A stacked bar of the categories, as a share of the total. The label names every category and its
// size, so the rows below stay the readable source and the segments are decoration.

export interface StorageMeterSegment {
  id: string
  bytes: number
  color: string
}

interface StorageMeterProps {
  segments: StorageMeterSegment[]
  label: string
}

// Every byte belongs to a category, so the bar is full: segments split the width by size, and no
// track shows through to read as free space.
export default function StorageMeter({ segments, label }: StorageMeterProps) {
  return (
    <div role="img" aria-label={label} className="mt-5 h-2 rounded-full overflow-hidden flex gap-0.5">
      {segments.filter((segment) => segment.bytes > 0).map((segment) => (
        <div
          key={segment.id}
          aria-hidden="true"
          className={`h-full basis-0 min-w-[3px] ${segment.color}`}
          style={{ flexGrow: segment.bytes }}
        />
      ))}
    </div>
  )
}
