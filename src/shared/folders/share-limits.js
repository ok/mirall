// The rules around a folder share's file bounds, in one place so the worker and the renderer
// cannot drift apart on them.

// Whether a listing read actually withheld rows — the fact the worker reports so the renderer never
// has to infer it. Two ways to be sure rows are missing, and the cap must have been hit for either:
//   - a COMPLETE read counted more than it returned, or
//   - the read was INCOMPLETE, so its own `total` is partial and cannot prove otherwise — assume
//     rows are missing rather than let the truncation go silent, which is how it hid before.
// A folder sitting exactly ON the cap is fully listed and is NOT truncated.
export function listingTruncated({ rowCount, total, cap, complete }) {
  if (!Number.isFinite(cap) || rowCount < cap) return false
  return total > rowCount || !complete
}
