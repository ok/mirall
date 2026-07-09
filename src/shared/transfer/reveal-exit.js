// `explorer.exe` returns exit code 1 even when it succeeds (a long-standing Windows
// quirk), so a 1 on win32 is NOT a reveal failure. `open` (macOS) and `xdg-open`
// (Linux) return 0 on success, so any other non-zero code is a real failure to log.
export function revealExitIsFailure (platform, code) {
  if (code === 0) return false
  if (platform === 'win32' && code === 1) return false
  return true
}
