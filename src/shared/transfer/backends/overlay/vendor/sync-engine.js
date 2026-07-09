/**
 * SyncEngine — Feed-based change tracking and conflict detection
 *
 * Each peer has a Hypercore feed logging file change operations.
 * When peers connect, feeds replicate automatically (Hypercore handles this).
 * The sync engine diffs feeds since the last-synced sequence number
 * and detects conflicts using three-value comparison:
 *
 *   my current hash vs their current hash vs last-synced hash (common ancestor)
 *
 * Conflict resolution is configurable per sync folder:
 *   prompt | newest-wins | keep-both | skip | mine-wins | theirs-wins
 */

import ReadyResource from 'ready-resource'

// Operation types written to the change feed
const OP_PUT = 0
const OP_DEL = 1

export const STRATEGIES = ['prompt', 'newest-wins', 'keep-both', 'skip', 'mine-wins', 'theirs-wins']

export class SyncEngine extends ReadyResource {
  constructor (fileIndex, corestore, opts = {}) {
    super()
    this._fileIndex = fileIndex
    this._corestore = corestore
    this._feed = null
    this._peerFeeds = new Map() // peerKey hex → Hypercore
    this._conflicts = []       // unresolved conflicts
    this._opts = opts
  }

  async _open () {
    // Local change feed — append-only log of file operations. [mirall] Encrypted
    // at rest under the M-derived overlay-index key (peer feeds, opened by key in
    // addPeerFeed, stay plaintext — we don't hold their key).
    const opts = { name: 'sync-feed', valueEncoding: 'json' }
    if (this._opts.encryptionKey) opts.encryptionKey = this._opts.encryptionKey
    this._feed = this._corestore.get(opts)
    await this._feed.ready()
  }

  async _close () {
    // Peer feeds are managed by corestore, no explicit close needed
  }

  /**
   * The local change feed (Hypercore)
   */
  get feed () { return this._feed }

  /**
   * The local feed's public key as hex
   */
  get feedKey () { return this._feed.key.toString('hex') }

  /**
   * Current unresolved conflicts
   */
  get conflicts () { return this._conflicts }

  // ── Change logging ──────────────────────────────────────────

  /**
   * Log a file put/update operation
   * @param {string} path - file path
   * @param {{ contentHash: string, size: number, mtime: number }} meta
   */
  async logPut (path, meta) {
    await this._feed.append({
      op: OP_PUT,
      path,
      hash: meta.contentHash,
      size: meta.size,
      mtime: meta.mtime,
      timestamp: Date.now()
    })
  }

  /**
   * Log a file deletion
   * @param {string} path - file path
   */
  async logDel (path) {
    await this._feed.append({
      op: OP_DEL,
      path,
      hash: null,
      size: 0,
      mtime: 0,
      timestamp: Date.now()
    })
  }

  // ── Peer feeds ──────────────────────────────────────────────

  /**
   * Add a remote peer's feed for syncing
   * @param {Buffer|string} key - peer's feed public key
   * @returns {Hypercore} the peer feed
   */
  addPeerFeed (key) {
    const keyHex = typeof key === 'string' ? key : key.toString('hex')
    if (this._peerFeeds.has(keyHex)) return this._peerFeeds.get(keyHex)

    const feed = this._corestore.get({ key: typeof key === 'string' ? Buffer.from(key, 'hex') : key, valueEncoding: 'json' })
    this._peerFeeds.set(keyHex, feed)
    return feed
  }

  /**
   * Get a peer feed by key
   * @param {string} keyHex
   * @returns {Hypercore|null}
   */
  getPeerFeed (keyHex) {
    return this._peerFeeds.get(keyHex) || null
  }

  // ── Feed diffing ────────────────────────────────────────────

  /**
   * Get new operations from a feed since a given sequence number
   * @param {Hypercore} feed
   * @param {number} sinceSeq - start reading from this seq (exclusive)
   * @returns {Array<{ seq: number, op: number, path: string, hash: string|null, size: number, mtime: number }>}
   */
  async getChanges (feed, sinceSeq) {
    await feed.ready()
    await feed.update()

    const changes = []
    const start = sinceSeq + 1
    const end = feed.length

    for (let i = start; i < end; i++) {
      const entry = await feed.get(i)
      changes.push({ seq: i, ...entry })
    }

    return changes
  }

  /**
   * Build a map of latest state per path from a list of changes.
   * Later entries override earlier ones for the same path.
   * @param {Array} changes
   * @returns {Map<string, { seq, op, hash, size, mtime }>}
   */
  buildChangeMap (changes) {
    const map = new Map()
    for (const c of changes) {
      map.set(c.path, { seq: c.seq, op: c.op, hash: c.hash, size: c.size, mtime: c.mtime })
    }
    return map
  }

  // ── Sync diff ───────────────────────────────────────────────

  /**
   * Compute the sync diff between local and a remote peer.
   * Returns actions to take: pull, push, conflict, or skip.
   *
   * @param {string} peerKey - hex key of the remote peer's feed
   * @returns {Array<{ path, action, local?, remote?, ancestor? }>}
   *   action: 'pull' | 'push' | 'conflict' | 'skip' | 'delete-local' | 'delete-remote'
   */
  async diff (peerKey) {
    const peerFeed = this._peerFeeds.get(peerKey)
    if (!peerFeed) throw new Error('Unknown peer: ' + peerKey)

    await peerFeed.ready()
    await peerFeed.update()

    // Get last-synced state for all files with this peer
    const syncStates = await this._fileIndex.listSyncStates(peerKey)
    const syncMap = new Map()
    for (const s of syncStates) {
      syncMap.set(s.path, s)
    }

    // Get my changes since last sync
    const myLastSeq = this._getMaxSyncedSeq(syncStates, 'local')
    const myChanges = await this.getChanges(this._feed, -1) // read all, filter by syncMap
    const myMap = this.buildChangeMap(myChanges)

    // Get their changes since last sync
    const theirChanges = await this.getChanges(peerFeed, -1) // read all
    const theirMap = this.buildChangeMap(theirChanges)

    // Collect all paths mentioned by either side
    const allPaths = new Set([...myMap.keys(), ...theirMap.keys()])

    const actions = []

    for (const path of allPaths) {
      const mine = myMap.get(path)
      const theirs = theirMap.get(path)
      const ancestor = syncMap.get(path)

      const myHash = mine ? mine.hash : null
      const theirHash = theirs ? theirs.hash : null
      const ancestorHash = ancestor ? ancestor.lastHash : null

      // Both have it and hashes match — in sync
      if (myHash && theirHash && myHash === theirHash) {
        actions.push({ path, action: 'skip', local: mine, remote: theirs })
        continue
      }

      // Only they have it (or they changed, I haven't)
      if (theirHash && !mine) {
        actions.push({ path, action: 'pull', remote: theirs })
        continue
      }

      // Only I have it (or I changed, they haven't)
      if (myHash && !theirs) {
        actions.push({ path, action: 'push', local: mine })
        continue
      }

      // Both null — both deleted
      if (!myHash && !theirHash) {
        actions.push({ path, action: 'skip' })
        continue
      }

      // One deleted, one has content
      if (mine && mine.op === OP_DEL && theirHash) {
        // I deleted, they still have it
        if (ancestorHash && ancestorHash === theirHash) {
          // They haven't changed since ancestor — propagate my delete
          actions.push({ path, action: 'delete-remote', local: mine, remote: theirs })
        } else {
          // They changed it after ancestor — conflict
          actions.push({ path, action: 'conflict', local: mine, remote: theirs, ancestor })
        }
        continue
      }

      if (theirs && theirs.op === OP_DEL && myHash) {
        // They deleted, I still have it
        if (ancestorHash && ancestorHash === myHash) {
          // I haven't changed since ancestor — accept their delete
          actions.push({ path, action: 'delete-local', local: mine, remote: theirs })
        } else {
          // I changed it after ancestor — conflict
          actions.push({ path, action: 'conflict', local: mine, remote: theirs, ancestor })
        }
        continue
      }

      // Both have different content — use ancestor to determine conflict
      if (myHash && theirHash && myHash !== theirHash) {
        if (ancestorHash === myHash) {
          // Only they changed — pull
          actions.push({ path, action: 'pull', local: mine, remote: theirs })
        } else if (ancestorHash === theirHash) {
          // Only I changed — push
          actions.push({ path, action: 'push', local: mine, remote: theirs })
        } else {
          // Both changed — conflict
          actions.push({ path, action: 'conflict', local: mine, remote: theirs, ancestor })
        }
        continue
      }

      // Fallback — shouldn't reach here
      actions.push({ path, action: 'skip', local: mine, remote: theirs })
    }

    return actions
  }

  // ── Conflict resolution ─────────────────────────────────────

  /**
   * Resolve a conflict using a strategy
   * @param {{ path, local, remote, ancestor }} conflict
   * @param {string} strategy - one of STRATEGIES
   * @returns {{ action: 'pull'|'push'|'keep-both'|'skip', winner?: 'local'|'remote' }}
   */
  resolveConflict (conflict, strategy) {
    switch (strategy) {
      case 'mine-wins':
        return { action: 'push', winner: 'local' }

      case 'theirs-wins':
        return { action: 'pull', winner: 'remote' }

      case 'newest-wins': {
        const mySeq = conflict.local ? conflict.local.seq : -1
        const theirSeq = conflict.remote ? conflict.remote.seq : -1
        if (mySeq >= theirSeq) {
          return { action: 'push', winner: 'local' }
        }
        return { action: 'pull', winner: 'remote' }
      }

      case 'keep-both':
        return { action: 'keep-both' }

      case 'skip':
        return { action: 'skip' }

      case 'prompt':
      default:
        // Add to conflict queue for user resolution
        this._conflicts.push(conflict)
        return { action: 'skip' }
    }
  }

  /**
   * Resolve a queued conflict by user choice
   * @param {string} path
   * @param {string} choice - 'overwrite' | 'keep-both' | 'skip'
   * @returns {{ action: string } | null}
   */
  resolveQueued (path, choice) {
    const idx = this._conflicts.findIndex(c => c.path === path)
    if (idx === -1) return null

    const conflict = this._conflicts.splice(idx, 1)[0]

    switch (choice) {
      case 'overwrite':
        return { action: 'pull', winner: 'remote', conflict }
      case 'keep-mine':
        return { action: 'push', winner: 'local', conflict }
      case 'keep-both':
        return { action: 'keep-both', conflict }
      case 'skip':
      default:
        return { action: 'skip', conflict }
    }
  }

  /**
   * Update sync state after a successful sync operation
   * @param {string} peerKey
   * @param {string} path
   * @param {string} hash - the hash both sides now agree on
   * @param {number} seq - the sequence number of the operation
   */
  async markSynced (peerKey, path, hash, seq) {
    await this._fileIndex.putSyncState(peerKey, path, {
      lastSeq: seq,
      lastHash: hash
    })
  }

  // ── Internal ────────────────────────────────────────────────

  _getMaxSyncedSeq (syncStates, _side) {
    let max = -1
    for (const s of syncStates) {
      if (s.lastSeq > max) max = s.lastSeq
    }
    return max
  }
}
