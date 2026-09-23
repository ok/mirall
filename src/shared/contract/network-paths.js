// Whether a path lives on a network mount. Native filesystem events never reach one, so a file
// there is watched by polling or not at all — the difference between a file that re-publishes on
// edit and one that quietly stops. The platform is a parameter: this package imports nothing, and
// the three runtimes that read it do not agree on how to name themselves.

/**
 * @param {string | null | undefined} p
 * @param {string} platform  'darwin' | 'linux' | 'win32'
 * @returns {boolean}
 */
export function looksLikeNetworkPath(p, platform) {
  if (!p) return false
  if (p.startsWith('\\\\')) return true
  if (platform === 'darwin' && p.startsWith('/Volumes/')) return true
  if (platform === 'linux' && (p.startsWith('/mnt/') || p.startsWith('/media/'))) return true
  return false
}
