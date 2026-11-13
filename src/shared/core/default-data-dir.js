// Where the desktop app keeps its profile, worked out without Electron. Electron's userData is
// <appData>/<app name> — the package's productName, not its npm name — and the store is the
// app-storage folder inside it. <appData> is ~/Library/Application Support on macOS, $APPDATA on
// Windows, and $XDG_CONFIG_HOME or ~/.config on Linux. Pure string math over the platform's own
// separator, so a unit test drives every platform under Node. An MSIX-packaged install has its
// AppData redirected by Windows; that path is not this one.

/** The store's folder inside the data folder, as the desktop app's runtime names it. */
export const STORE_DIR = 'app-storage'

/** @param {string} platform @param {string[]} parts @returns {string} */
export function joinFor(platform, ...parts) {
  const sep = platform === 'win32' ? '\\' : '/'
  return parts
    .map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(sep)
}

/**
 * @param {{ platform: string, env: Record<string, string | undefined>, homedir: string }} where
 * @returns {string}
 */
export function appDataDir({ platform, env, homedir }) {
  if (platform === 'darwin') return joinFor(platform, homedir, 'Library', 'Application Support')
  if (platform === 'win32') return env.APPDATA || joinFor(platform, homedir, 'AppData', 'Roaming')
  return env.XDG_CONFIG_HOME || joinFor(platform, homedir, '.config')
}

/**
 * The folder the desktop app reads and writes as userData.
 * @param {{ platform: string, env: Record<string, string | undefined>, homedir: string, productName: string }} where
 * @returns {string}
 */
export function defaultDataDir({ platform, env, homedir, productName }) {
  return joinFor(platform, appDataDir({ platform, env, homedir }), productName)
}
