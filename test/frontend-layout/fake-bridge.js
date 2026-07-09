// Classic (non-module) script — MUST load before the ESM harness bundle so that
// `src/renderer/ipc.ts`, which calls `ensureWorker()` at import time, finds a
// populated `window.bridge`. We fake the worker end of the bridge: the renderer
// writes NDJSON request envelopes via `writeWorkerIPC`, and we reply through the
// `onWorkerIPC` callback exactly like the real main↔worker pipe — so the real
// `ipc.ts` + hooks + components run completely unmodified.
;(function () {
  const enc = new TextEncoder()
  const dec = new TextDecoder('utf-8')

  // ---- canned worker state -------------------------------------------------
  const SPACE_ID = 'space1'
  const SHARE_ID = 'share1'
  const OWNER_PK = 'owner-pk-0000000000000000000000000000000000000000000000000000000000'
  const SELF_PK = 'self-pk-00000000000000000000000000000000000000000000000000000000000'

  // 173 files, mirroring the user's screenshot (a FLAC-rip album with both the
  // padded and unpadded track filenames) — enough rows to overflow the list. The first six
  // report 'downloading' so the harness's decoration frames actually paint (the renderer's
  // decoration merge is gated on the worker-derived status).
  const files = []
  for (let i = 1; i <= 173; i++) {
    const nn = String(i).padStart(2, '0')
    files.push({
      relPath: `[CLV009] - Vhinz - Belvedere Flac/${nn} - Track number ${i}.mp3`,
      size: 7_000_000 + ((i * 131) % 4000) * 1000,
      hash: 'h'.repeat(64),
      mtime: 0,
      status: i <= 6 ? 'downloading' : 'remote',
      localPath: null,
    })
  }

  const profile = { displayName: 'You', avatar: null, publicKey: SELF_PK }
  const members = [
    { publicKey: OWNER_PK, driveKey: 'd'.repeat(64), displayName: 'Vhinz', online: true, avatar: null },
    { publicKey: SELF_PK, driveKey: 'e'.repeat(64), displayName: 'You', online: true, avatar: null },
  ]
  const space = {
    spaceId: SPACE_ID, name: 'Aurora', icon: 'folder', topic: 't'.repeat(64),
    created: '2026-01-01', members, favorite: false,
  }
  const foreignMount = {
    spaceId: SPACE_ID, shareId: SHARE_ID, mountPath: '/tmp/mirror', enabled: true,
    attachedAt: 0, status: 'active',
  }

  function folderInfo() {
    const totalBytes = files.reduce((a, f) => a + f.size, 0)
    return { fileCount: files.length, totalBytes, blobsLength: null }
  }

  function route(type, payload) {
    switch (type) {
      case 'ping': return { ok: true }
      case 'share:list-files': return { entries: files, complete: true }
      case 'share:folder-info': return folderInfo()
      case 'spaces:list': return [space]
      case 'space:members': return members
      case 'profile:get': return profile
      case 'members:online': return [OWNER_PK, SELF_PK]
      case 'foreign-folder:get': return foreignMount
      case 'owned-folder:get': return null
      case 'features:get': return { overlay: false }
      // Routes the full SpaceView mount (members layout harness) needs; the
      // FolderView scenario never calls these, so the empties are inert there.
      case 'files:list': return []
      case 'share:list': return []
      case 'space:storage-summary': return { totalBytes: folderInfo().totalBytes, onDeviceBytes: 0 }
      case 'space:pending-requests': return (window.__HARNESS_CFG && window.__HARNESS_CFG.pendingRequests) || []
      case 'foreign-folder:list-all': return []
      case 'owned-folder:list-all': return []
      default: return null
    }
  }

  let ipcCb = null
  function reply(obj) {
    if (!ipcCb) return
    ipcCb(enc.encode(JSON.stringify(obj) + '\n'))
  }

  // Expose a driver surface to the harness entry.
  window.__fake = { SPACE_ID, SHARE_ID, OWNER_PK, files }
  window.__fakeEmit = (eventObj) => reply(eventObj)

  const noop = () => {}
  const asyncNoop = () => Promise.resolve()

  window.bridge = {
    pkg: () => ({ version: '0.0.0-test' }),
    isDev: () => false,
    getLocale: () => 'en-US',
    getPlatform: () => 'darwin',
    getPathForFile: () => '',
    appVersion: asyncNoop,
    getChangelog: () => Promise.resolve([]),
    onPearEvent: noop,

    startWorker: asyncNoop,
    onWorkerIPC: (_spec, listener) => { ipcCb = listener },
    onWorkerStdout: noop,
    onWorkerStderr: noop,
    onWorkerExit: noop,
    writeWorkerIPC: (_spec, data) => {
      const text = dec.decode(data)
      for (const line of text.split('\n')) {
        if (!line) continue
        let env
        try { env = JSON.parse(line) } catch { continue }
        const { id, type, ...payload } = env
        const send = () => reply({ id, data: route(type, payload) })
        const cfg = window.__HARNESS_CFG
        const delayMs = cfg && cfg.rpcDelayMs && Array.isArray(cfg.delayTypes) && cfg.delayTypes.includes(type) ? cfg.rpcDelayMs : 0
        // Reply on a microtask, like a real async worker round-trip; a harness may delay a
        // specific request type so a transient in-flight UI state is observable.
        if (delayMs > 0) setTimeout(send, delayMs)
        else Promise.resolve().then(send)
      }
      return Promise.resolve()
    },

    getWindowBounds: asyncNoop,
    setWindowBounds: asyncNoop,
    getZoom: () => Promise.resolve(1),
    setZoom: asyncNoop,
    setTheme: asyncNoop,
    getDownloadFolder: () => Promise.resolve('/tmp'),
    setDownloadFolder: asyncNoop,
    browseDownloadFolder: asyncNoop,
    browseShareFolder: asyncNoop,
    startOwnedFolderWatcher: asyncNoop,
    stopOwnedFolderWatcher: asyncNoop,
    onZoomChanged: noop,
    notify: asyncNoop,
    notifyIsSupported: () => Promise.resolve(false),
    isWindowFocused: () => Promise.resolve(true),
    focusWindow: asyncNoop,
    showInFolder: asyncNoop,
    onNotificationClick: noop,
    getPrefs: () => Promise.resolve({}),
    setPrefs: asyncNoop,
    setTrayLabels: noop,
    menuContextChanged: asyncNoop,
    onFirstHideNotice: noop,
    onHiddenToTray: noop,
    onKeyboardCommand: noop,
    deepLink: { subscribe: () => noop },
  }
})()
