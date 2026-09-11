// The Bare twin of timing.js, for test/integration: Bare has no `process`, so the scale factor is
// read through bare-os. Same contract as there — a wait helper scales the `ms` it RECEIVES, so call
// sites pass a dev-box base value and only the helper knows about the scale.
import os from 'bare-os'

const raw = Number(os.getEnv('MIRALL_TEST_TIMEOUT_SCALE'))
export const TIMEOUT_SCALE = Number.isFinite(raw) && raw > 0 ? raw : 1

export function scaled(baseMs) {
  return Math.round(baseMs * TIMEOUT_SCALE)
}
