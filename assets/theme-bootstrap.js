// Resolve the stored theme synchronously before the stylesheet loads so
// the very first paint matches the BrowserWindow's native background
// (set in src/main/main.js). Without this, a dark-mode user would
// briefly see a flash of the light cream background before the React
// bundle parses and toggles the .dark class.
//
// The source of truth is config.json (appearance.theme), reachable here
// through the synchronous config:get IPC the preload exposes as
// window.bridge.getConfig() — reading it keeps the first paint in lockstep
// with the store the rest of the app uses. The legacy `mirall:theme`
// localStorage key is only a fallback for the one boot right after the
// config.json migration (config-client.ts) deletes it; nothing writes it
// anymore, so reading it alone left this guess permanently stuck on 'system'.
(function () {
  try {
    var cfg = window.bridge && window.bridge.getConfig ? window.bridge.getConfig() : null
    var saved = (cfg && cfg.appearance && cfg.appearance.theme) || localStorage.getItem('mirall:theme')
    var mode = saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
    var dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.add(dark ? 'dark' : 'light')
    // Match color-scheme on first paint so native scrollbars render in the
    // right scheme immediately, before the React bundle runs applyTheme.
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  } catch (_) {
    document.documentElement.classList.add('light')
    document.documentElement.style.colorScheme = 'light'
  }
})()
