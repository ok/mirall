// The renderer's read surface onto Electron MAIN — the main-process twin of
// src/shared/contract/requests.js. A fact belongs here when it is (a) owned by main, (b) a
// singleton (no params — main facts are per-app, not per-space), and (c) worth caching across the
// components that read it.
//
// `read` and `write` are the bridge accessors. `push` names the bridge subscription that reports a
// change main made on its own; a fact with no push changes ONLY when this app writes it, which is
// what makes write-through sufficient.
export const MAIN_QUERIES = Object.freeze({
  'main:prefs': { read: (b) => b.getPrefs(), write: (b, v) => b.setPrefs(v), push: null },
  'main:download-folder': { read: (b) => b.getDownloadFolder(), write: (b, v) => b.setDownloadFolder(v), push: null },
  'main:bandwidth': { read: (b) => b.getBandwidth(), write: (b, v) => b.setBandwidth(v), push: null },
  'main:zoom': { read: (b) => b.getZoom(), write: (b, v) => b.setZoom(v), push: 'onZoomChanged' },
})

export const MAIN_QUERY_NAMES = Object.freeze(Object.keys(MAIN_QUERIES))
