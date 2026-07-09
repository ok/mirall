// Flow tests measure CPU-bound eventual-consistency convergence; a 2-vCPU CI
// runner is far slower than a dev box, so MIRALL_TEST_TIMEOUT_SCALE scales every
// poll/test timeout from one place. Helpers scale the `ms` they receive, so call
// sites pass base values; only brittle's per-test `{ timeout }` needs scaled().
const raw = Number(process.env.MIRALL_TEST_TIMEOUT_SCALE)
export const TIMEOUT_SCALE = Number.isFinite(raw) && raw > 0 ? raw : 1
export const TIMING = !!process.env.MIRALL_TEST_TIMING

export function scaled (baseMs) {
  return Math.round(baseMs * TIMEOUT_SCALE)
}

export function summarize (value, max = 800) {
  let s
  try { s = JSON.stringify(value) } catch { return String(value) }
  if (s == null) return String(value)
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max} more chars)` : s
}

export function tail (s, max = 1500) {
  if (!s) return '(no worker stderr captured)'
  return s.length > max ? `…${s.slice(-max)}` : s
}
