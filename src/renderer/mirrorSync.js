// What a mirror still has to fetch, derived from the rows the view already holds — no new IPC.
//
// Deliberately counts what is NOT here yet rather than what is moving: a mirror fetches one file at
// a time (`activeOverlayFetches` holds one entry per mount), so counting 'downloading' rows would
// report "1 file" for a 5,000-file folder and flicker to zero between every file. And 'preparing'
// is not our work at all — it means the OWNER has not hashed that entry yet.
//
// The percentage is dropped when the listing is truncated: past the cap the rows are a capped
// sample, so bytes-on-device over bytes-total would be computed from a subset and read low.

const ON_DEVICE = new Set(['downloaded', 'synced'])

export function deriveMirrorSync (files, opts = {}) {
  const truncated = !!opts.truncated
  const enabled = opts.enabled !== false
  let pending = 0
  let bytesRemaining = 0
  let onDeviceBytes = 0
  let totalBytes = 0
  for (const file of files) {
    const size = Number.isFinite(file.size) ? file.size : 0
    totalBytes += size
    if (ON_DEVICE.has(file.status)) {
      onDeviceBytes += size
      continue
    }
    pending += 1
    const done = file.progress?.bytes ?? file.pendingBytes ?? 0
    bytesRemaining += Math.max(0, size - done)
    onDeviceBytes += Math.min(size, done)
  }
  const onDevice = files.length - pending
  if (!enabled || pending === 0) {
    return { active: false, files: 0, onDevice, bytesRemaining: 0, pct: null, indeterminate: false }
  }
  const canMeasure = !truncated && totalBytes > 0
  return {
    active: true,
    files: pending,
    onDevice,
    bytesRemaining,
    pct: canMeasure ? Math.min(100, Math.round((onDeviceBytes / totalBytes) * 100)) : null,
    indeterminate: !canMeasure,
  }
}
