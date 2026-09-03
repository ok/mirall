// Whether a mount's durable status is a local fault, and what to name it by. Both roles write the
// same two statuses and neither had anywhere to show them: every consumer of mount.status compared
// against 'mount-point-gone' or 'paused' only, so a folder stopped by a full disk rendered exactly
// like a healthy one once its 8-second toast had gone.
//
// `code` is an error code the renderer already translates, never a raw errno message. A status with
// no reason recorded still names itself — 'paused-enospc' IS the disk-full case — which is what
// keeps a mirror paused before this shipped from rendering a blank reason.
const FAULT_STATUSES = new Set(['paused-error', 'paused-enospc'])

const CODE_BY_STATUS = {
  'paused-enospc': 'TRANSFER_DISK_FULL',
}

export function isMountFault (status) {
  return FAULT_STATUSES.has(status)
}

export function mountFault (status, lastError) {
  if (!isMountFault(status)) return null
  return { status, code: lastError || CODE_BY_STATUS[status] || null }
}
