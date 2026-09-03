// process.platform decides whether a path counts as a network mount: /Volumes is a darwin-only
// signal, /mnt and /media are linux-only, and only a UNC path is one everywhere. Any test that
// asserts that routing has to PIN the platform rather than inherit the machine's — CI runs
// Linux and development happens on macOS, so an unpinned '/Volumes/…' test passes locally and
// fails there. That is exactly how it went the first time.
export function withPlatform (name, fn) {
  const real = process.platform
  Object.defineProperty(process, 'platform', { value: name, configurable: true })
  try { return fn() } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true })
  }
}

// A UNC path is a network path on every platform, so it is the one target that routes to polling
// without pinning the platform first. Use it wherever the test is about something else.
export const UNC_PATH = '\\\\server\\share\\report.pdf'

// Every real-world shape of "this file lives where native fs events cannot reach", paired with
// the platform that recognises it.
export const NETWORK_CASES = [
  { platform: 'darwin', path: '/Volumes/NAS/report.pdf', label: 'macOS /Volumes' },
  { platform: 'linux', path: '/mnt/nas/report.pdf', label: 'Linux /mnt' },
  { platform: 'linux', path: '/media/usb/report.pdf', label: 'Linux /media' },
  { platform: 'win32', path: UNC_PATH, label: 'Windows UNC' },
]
