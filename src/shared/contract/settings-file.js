// The worker's settings file beside the store, and the config.json groups that moved into it. Main
// drops the moved groups from config.json once this file exists; the worker imports them once when
// it does not.
export const SETTINGS_FILE = 'settings.json'
export const MOVED_GROUPS = Object.freeze(['downloads', 'network', 'backup'])
