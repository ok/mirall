// The folder a user picks for the backup is the backup itself. A backup starts only in a folder that
// already holds one — its header, or the key setup writes before the first run — or that holds
// nothing besides what the system, a drive or a sync client leaves in any folder. It never mixes with
// the user's own files, and never takes a folder of theirs for its own because of its name.
export const BACKUP_HEADER = 'mirall-backup.json'
export const BACKUP_KEYS_DIR = 'keys'
// Compared lowercased: a drive root on Windows, a custom folder icon on macOS, a NAS's own folders.
const SYSTEM_ENTRIES = new Set(['desktop.ini', 'thumbs.db', 'system volume information', '$recycle.bin', 'icon\r', 'lost+found', '@eadir', '#recycle', '#snapshot'])

/** @param {string} name */
const isSystemEntry = (name) => name.startsWith('.') || SYSTEM_ENTRIES.has(name.toLowerCase())

/** @param {string[]} names */
export const holdsBackup = (names) => names.includes(BACKUP_HEADER) || names.includes(BACKUP_KEYS_DIR)

/** @param {string[]} names */
export const fitsNewBackup = (names) => holdsBackup(names) || names.every(isSystemEntry)
