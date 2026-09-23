// The decisions behind the filesystem watcher, kept apart from the watching so test/unit can drive
// them under plain Node: which of the three ways a root is watched, and which of the three words a
// settled path is reported with.
import { looksLikeNetworkPath } from '../contract/network-paths.js'

// One handle for the whole tree, one per directory, or a stat walk on an interval. Chosen once per
// root and never mixed: the option is per WATCHER, not per path.
export const WATCH_MODE = Object.freeze({
  RECURSIVE: 'recursive',
  TREE: 'tree',
  POLL: 'poll',
})

/** @typedef {(typeof WATCH_MODE)[keyof typeof WATCH_MODE]} WatchMode */

/**
 * A network mount emits no native events at all, whatever the platform, so the path decides before
 * the platform does. inotify then watches exactly the one directory it is given and ignores the
 * recursive flag; darwin and win32 honour it.
 * @param {string} absPath
 * @param {string} platform  'darwin' | 'linux' | 'win32'
 * @returns {WatchMode}
 */
export function watchModeFor(absPath, platform) {
  if (looksLikeNetworkPath(absPath, platform)) return WATCH_MODE.POLL
  return platform === 'linux' ? WATCH_MODE.TREE : WATCH_MODE.RECURSIVE
}

/**
 * The word a settled path is reported with. The runtime says only `rename | change`, and a rename
 * is a rename on both of its names with no change on the target, so which side a name is on comes
 * from a stat: present and newly named is an add, present and merely touched is a change, absent is
 * an unlink. A name that appeared and was gone again inside one window is reported as the unlink,
 * which the retire path re-confirms against disk before it acts.
 * @param {{ exists: boolean, sawRename: boolean }} facts
 * @returns {'add' | 'change' | 'unlink' | null} null for a change to a path that is not there
 */
export function settledAction({ exists, sawRename }) {
  if (exists) return sawRename ? 'add' : 'change'
  return sawRename ? 'unlink' : null
}

/**
 * Is `p` strictly below `prefix`? Compared on a whole separator, so `/a/bb` is not below `/a/b` and
 * a renamed directory cannot drag its sibling's watchers down with it.
 * @param {string} p
 * @param {string} prefix
 * @param {string} sep
 * @returns {boolean}
 */
export function underPrefix(p, prefix, sep) {
  return p.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep)
}
