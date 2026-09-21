// DIAGNOSTIC — the data-directory tripwire's rule, shared by both processes.
//
// The live profile has been destroyed twice (2026-08-19, 2026-09-18) with no root cause. Reading
// the code found nothing that removes a directory tree, so this catches the act instead: every
// filesystem call that could destroy or replace the data dir is checked against this rule, and a
// match is logged with a stack and refused.
//
// The rule takes ALREADY-RESOLVED absolute paths and compares them as strings, with no path module
// of its own, so one implementation serves Node (`path`) and Bare (`bare-path`) alike and stays
// unit-testable without either. Each installer resolves with its own path module first.

/** @typedef {'data-dir' | 'ancestor' | 'store' | null} TripKind */

const STORE_DIR = 'app-storage'

function trimTrailing(p, sep) {
  let end = p.length
  while (end > 1 && p[end - 1] === sep) end--
  return p.slice(0, end)
}

/**
 * What a filesystem call would destroy, if anything worth stopping.
 *
 *   'data-dir' — the profile directory itself
 *   'ancestor' — something containing it, so it goes too
 *   'store'    — the whole corestore in one act
 *
 * Children BELOW the store are deliberately not matched: deleting a transfer journal, a stale WAL
 * segment or a purged core is ordinary work, and a guard that fired on those would be noise. The
 * question here is only ever "does this take out the entire profile".
 *
 * @param {string} target resolved absolute path the call would destroy
 * @param {string} dataDir resolved absolute path of the profile directory
 * @param {string} [sep] path separator
 * @returns {TripKind}
 */
export function classifyResolved(target, dataDir, sep = '/') {
  if (typeof target !== 'string' || typeof dataDir !== 'string') return null
  if (target === '' || dataDir === '') return null
  const t = trimTrailing(target, sep)
  const d = trimTrailing(dataDir, sep)
  if (t === d) return 'data-dir'
  // The POSIX root trims to "/" rather than "", so the prefix test below would compare against
  // "//" and miss it. Every absolute path is inside the root by definition.
  if (t === sep) return 'ancestor'
  // An ancestor is a prefix ending at a separator — the trailing sep is what keeps
  // "/Users/oliver/Library/Application Support/Mirall copy" from matching ".../Mirall".
  if (d.startsWith(t + sep)) return 'ancestor'
  if (t === d + sep + STORE_DIR) return 'store'
  return null
}

/** The calls worth guarding: each can unlink or replace a directory entry. */
export const GUARDED_SYNC = ['rmSync', 'rmdirSync', 'unlinkSync', 'renameSync']
export const GUARDED_ASYNC = ['rm', 'rmdir', 'unlink', 'rename']

/** How many leading arguments of each call are paths (rename takes two). */
export function pathArity(name) {
  return name.startsWith('rename') ? 2 : 1
}
