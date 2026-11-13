// The back end's file watchers as one lifetime: the recursive roots of owned folders and mirrors,
// and the loose files shared in place. They start and end with the back end, so a back end with no
// window still notices a changed file. Each event is handed to the data layer's own handler for
// that kind, exactly as a file event has always been handled.
//
// A watcher fault never reaches the back end: an arm that throws is logged and skipped, and an
// event whose handling fails is logged and dropped. The periodic reconcile and the mirror's full
// walk re-derive what a lost event would have said.
//
// With the `testFileWatchersOff` lever the bookkeeping runs on an engine that never reports, and
// the test supplies the file events itself (ipc/test-fs-events.js).
import { Subsystem } from '../../shared/core/subsystem.js'
import { areFileWatchersOff } from '../../shared/core/runtime-config.js'
import { handleOwnedFsEvent } from '../../shared/folders/owned-watcher.js'
import { handleMirrorFsEvent } from '../../shared/folders/mirror-watcher.js'
import { handleLooseFsEvent } from '../../shared/transfer/overlay/loose-publish.js'
import { watchEnv } from './watch-host.js'
import { createFolderWatchers } from './folder-watchers.js'
import { createLooseFileWatchers } from './loose-file-watchers.js'

// A mirror's watcher is keyed by its mount pair; an owned share's by its id alone.
const mirrorWatchKey = (spaceId, shareId) => spaceId + ':' + shareId

export class FileWatchers extends Subsystem {
  constructor(name, deps) {
    super(name, deps)
    /** @type {ReturnType<typeof createFolderWatchers> | null} */
    this.folders = null
    /** @type {ReturnType<typeof createLooseFileWatchers> | null} */
    this.looseFiles = null
  }

  async _open() {
    // deps.env is a test seam: an engine of the test's own, in place of the package.
    const env = this.deps.env ?? watchEnv({ log: this.log, off: areFileWatchersOff() })
    this.folders = createFolderWatchers(env)
    this.looseFiles = createLooseFileWatchers(env, {
      onEvent: (event) => this._deliver('loose-file', () => handleLooseFsEvent(event)),
      // A warning, not a debug line: the error-storm message is the one signal saying this file
      // stopped syncing and will not resume on its own.
      onError: (err) => this.log.warn('loose watcher error -', err.message),
    })
  }

  async _close() {
    this.stopAll()
  }

  // Every watch, closed at once. Also called ahead of the close, so no event reaches a data layer
  // that is shutting down.
  stopAll() {
    this.folders?.stopAll()
    this.looseFiles?.stopAll()
  }

  /** @param {string} shareId @param {string} mountPath @param {readonly string[] | null | undefined} ignore */
  watchOwned(shareId, mountPath, ignore) {
    this._arm('owned folder ' + shareId, (folders) => folders.start(shareId, mountPath, ignore || [],
      (event) => this._deliver('owned-folder', () => handleOwnedFsEvent({ shareId, ...event })),
      (err) => this.log.warn('watcher error', shareId, '-', err.message)))
  }

  /** @param {string} shareId */
  unwatchOwned(shareId) {
    this.folders?.stop(shareId)
  }

  /** @param {{ spaceId: string, shareId: string, mountPath: string }} mount */
  watchMirror({ spaceId, shareId, mountPath }) {
    this._arm('mirror ' + shareId, (folders) => folders.start(mirrorWatchKey(spaceId, shareId), mountPath, null,
      ({ action, relPath }) => this._deliver('foreign-folder', () => handleMirrorFsEvent({ spaceId, shareId, action, relPath })),
      (err) => this.log.warn('mirror watcher error', shareId, '-', err.message)))
  }

  /** @param {string} spaceId @param {string} shareId */
  unwatchMirror(spaceId, shareId) {
    this.folders?.stop(mirrorWatchKey(spaceId, shareId))
  }

  /** @param {string} spaceId @param {string} absPath */
  watchLoose(spaceId, absPath) {
    if (this.stopping || !this.looseFiles) return
    try { this.looseFiles.add(spaceId, absPath) } catch (err) {
      this.log.warn('loose watch not armed for', absPath, '-', err.message)
    }
  }

  /** @param {string} spaceId @param {string} absPath */
  unwatchLoose(spaceId, absPath) {
    this.looseFiles?.remove(spaceId, absPath)
  }

  /** @internal what a test asks: where an owned folder's watcher points */
  watchedOwnedPath(shareId) { return this.folders?.watchedPath(shareId) ?? null }
  /** @internal */
  watchedMirrorPath(spaceId, shareId) { return this.folders?.watchedPath(mirrorWatchKey(spaceId, shareId)) ?? null }
  /** @internal */
  spacesWatchingLoose(absPath) { return this.looseFiles?.spacesWatching(absPath) ?? [] }

  // Nothing is armed once the close has begun: a watch armed then would outlive the back end.
  _arm(what, start) {
    if (this.stopping || !this.folders) return
    try { start(this.folders) } catch (err) {
      this.log.warn('watch not armed for', what, '-', err.message)
    }
  }

  _deliver(kind, handle) {
    try {
      Promise.resolve(handle()).catch((err) => this.log.warn(kind, 'fs event failed:', err.message))
    } catch (err) {
      this.log.warn(kind, 'fs event failed:', err.message)
    }
  }
}
