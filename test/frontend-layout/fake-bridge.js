// Classic (non-module) script — MUST load before the ESM harness bundle so that
// `src/renderer/ipc/ipc.ts`, which calls `ensureWorker()` at import time, finds a
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

  const profile = { displayName: 'You', avatar: null, personKey: SELF_PK, deviceKey: SELF_PK, orgKey: null }
  const members = [
    { publicKey: OWNER_PK, displayName: 'Vhinz', online: true, avatar: null },
    { publicKey: SELF_PK, displayName: 'You', online: true, avatar: null },
  ]
  // schemaVersion 2 is what every shipped space carries; without it SpaceScreen renders the
  // legacy banner and hides the drop zone, i.e. not the screen users see.
  const space = {
    spaceId: SPACE_ID, name: 'Aurora', icon: 'folder', topic: 't'.repeat(64),
    created: '2026-01-01', members, favorite: false, schemaVersion: 2, downloadFolder: '/Users/you/Downloads',
  }
  const foreignMount = {
    spaceId: SPACE_ID, shareId: SHARE_ID, mountPath: '/tmp/mirror', enabled: true,
    attachedAt: 0, status: 'active',
  }

  function folderInfo() {
    const totalBytes = files.reduce((a, f) => a + f.size, 0)
    return { fileCount: files.length, totalBytes, blobsLength: null, complete: true }
  }

  // Tracks the request vocabulary in src/shared/contract/requests.js: a request with no case here
  // resolves null, which the screen renders as an empty state rather than an error — so a harness
  // missing a route fails as a wrong layout assertion instead of as a missing route.
  // Both file listings answer one envelope (ContentListing in the contract).
  function listing(entries) {
    const totalBytes = entries.reduce((sum, row) => sum + (row.size || 0), 0)
    return { entries, complete: true, total: entries.length, totalBytes, truncated: false, fileLimit: null }
  }

  function route(type, payload) {
    switch (type) {
      case 'ping': return { ok: true }
      // A harness that needs its own tree seeds `shareFiles`; the default is the album above.
      case 'share:list-files': return listing((window.__HARNESS_CFG && window.__HARNESS_CFG.shareFiles) || files)
      case 'share:folder-info': return folderInfo()
      case 'spaces:list': return (window.__HARNESS_CFG && window.__HARNESS_CFG.spaces) || [space]
      case 'space:members': return members
      case 'space:mirrors': return (window.__HARNESS_CFG && window.__HARNESS_CFG.mirrors) || []
      case 'profile:get': return profile
      case 'members:online': return [OWNER_PK, SELF_PK]
      case 'members:reach': return (window.__HARNESS_CFG && window.__HARNESS_CFG.reach) || { members: {} }
      case 'foreign-folder:get': return foreignMount
      case 'owned-folder:get': return null
      // Routes the full SpaceScreen mount (members layout harness) needs; the
      // FolderScreen scenario never calls these, so the empties are inert there.
      // A harness that wants a populated space screen seeds these two through __HARNESS_CFG;
      // the scenarios that only need the shell keep the empty listings.
      case 'files:list': return listing((window.__HARNESS_CFG && window.__HARNESS_CFG.files) || [])
      case 'share:list': return (window.__HARNESS_CFG && window.__HARNESS_CFG.shares) || []
      case 'space:storage-summary': return { totalBytes: folderInfo().totalBytes, onDeviceBytes: 0, complete: true }
      case 'space:pending-requests': return (window.__HARNESS_CFG && window.__HARNESS_CFG.pendingRequests) || []
      case 'space:deny-member': return (window.__HARNESS_CFG && window.__HARNESS_CFG.denyReplies && window.__HARNESS_CFG.denyReplies.shift()) || { outcome: 'denied' }
      case 'foreign-folder:list-all': return []
      case 'serving:detail-subscribe': return { peers: (window.__HARNESS_CFG && window.__HARNESS_CFG.detail) || [] }
      case 'owned-folder:list-all': return []
      // A fresh answer each time, as the worker's re-probe sends one.
      case 'downloads:roots-status': return { unavailable: [...((window.__HARNESS_CFG && window.__HARNESS_CFG.unavailable) || [])] }
      case 'settings:get': return {
        downloads: { folder: '/Users/you/Downloads', isDefault: true, recent: ['/Users/you/Downloads', '/Users/you/Projects/Handover'] },
        network: { downloadKBps: 0, uploadKBps: 0, relayMode: 'off', relay: null },
        links: { baseUrl: 'https://mirall.app' },
        hostPaths: { home: '/Users/you', sep: '/', caseFolds: true },
      }
      default: return null
    }
  }

  let ipcCb = null
  function reply(obj) {
    if (!ipcCb) return
    ipcCb(enc.encode(JSON.stringify(obj) + '\n'))
  }

  // Expose a driver surface to the harness entry. `__fakeRequests` counts each request type the
  // page has sent, for a harness that asserts what a screen asks the worker.
  window.__fake = { SPACE_ID, SHARE_ID, OWNER_PK, SELF_PK, files, members }
  window.__fakeEmit = (eventObj) => reply(eventObj)
  window.__fakeRequests = {}

  const noop = () => {}
  const asyncNoop = () => Promise.resolve()

  window.bridge = {
    pkg: () => ({ version: '0.0.0-test' }),
    isDev: () => false,
    getLocale: () => 'en-US',
    getPlatform: () => 'darwin',
    getPathForFile: () => '',
    appVersion: asyncNoop,
    getChangelog: () => Promise.resolve(''),
    getUpdateStatus: () => Promise.resolve({ state: 'idle', nextVersion: null, lastCheckedAt: null, offReason: null, canRestart: false }),
    onUpdateStatus: () => noop,

    startWorker: asyncNoop,
    restartWorker: asyncNoop,
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
        window.__fakeRequests[type] = (window.__fakeRequests[type] || 0) + 1
        const cfg = window.__HARNESS_CFG
        // A harness may fail a request type for the whole page, the way a worker refusal reaches it.
        const send = () => reply(cfg && Array.isArray(cfg.failTypes) && cfg.failTypes.includes(type)
          ? { id, error: 'worker refused ' + type }
          : { id, data: route(type, payload) })
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
    browseDownloadFolder: asyncNoop,
    browseShareFolder: asyncNoop,
    retryIdentityUnlock: async () => false,
    onZoomChanged: noop,
    notify: asyncNoop,
    isWindowFocused: () => Promise.resolve(true),
    focusWindow: asyncNoop,
    showInFolder: () => Promise.resolve({ ok: true }),
    onNotificationClick: noop,
    getPrefs: () => Promise.resolve({}),
    setPrefs: asyncNoop,
    setTrayLabels: noop,
    menuContextChanged: asyncNoop,
    onFirstHideNotice: noop,
    onHiddenToTray: noop,
    onKeyboardCommand: noop,
    // ConnectionStatusProvider reads these on mount; a missing method throws during render and
    // takes the whole tree down, so any harness mounting a real screen renders nothing at all.
    getNetOnline: () => Promise.resolve(true),
    onNetOnlineChange: () => noop,
    deepLink: { subscribe: () => noop },
  }
})()
