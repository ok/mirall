// A stacked bar of the categories, as a share of the total. The label names every category and its
// size, so the rows below stay the readable source and the segments are decoration.

export interface StorageMeterSegment {
  id: string
  bytes: number
  color: string
}

interface StorageMeterProps {
  segments: StorageMeterSegment[]
  total: number
  label: string
}

// Scaled to the larger of the total and the segments' sum: categories are logical sizes, and they can
// outrun a folder measured at another moment.
export default function StorageMeter({ segments, total, label }: StorageMeterProps) {
  const scale = Math.max(total, segments.reduce((sum, segment) => sum + segment.bytes, 0))
  return (
    <div role="img" aria-label={label} className="mt-5 h-2 bg-progress-track rounded-full overflow-hidden flex gap-px">
      {segments.filter((segment) => segment.bytes > 0).map((segment) => (
        <div
          key={segment.id}
          aria-hidden="true"
          className={`h-full min-w-[3px] ${segment.color}`}
          style={{ width: `${scale > 0 ? (segment.bytes / scale) * 100 : 0}%` }}
        />
      ))}
    </div>
  )
}
