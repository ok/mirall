import './platform.js'
import './updates.js'
import './i18n.js'
import './dev-console.js'
import { createRoot } from 'react-dom/client'
import App from './app.js'
import { request } from './ipc.js'
import { configureQueryStore } from './store/query-store.js'
import { configurePrefsStore } from './store/prefs-store.js'
import { installReconcileBridge } from './store/reconcile.js'

// Before the first render: the store's transport, and the single reconcile subscription every
// store-backed view re-derives from.
configureQueryStore({ request: (type, params, opts) => request(type, params, undefined, opts) })
configurePrefsStore({ getPrefs: () => window.bridge.getPrefs(), setPrefs: (patch) => window.bridge.setPrefs(patch) })
installReconcileBridge()

if (__DEV__ && window.bridge?.isDev?.()) {
  void (async () => {
    try {
      // axe-core/react instruments by overwriting React.createElement, so it
      // needs the mutable CommonJS module object — the ESM namespace exposes
      // createElement as a getter-only prop and the patch throws.
      const [{ default: axe }, { default: React }, { default: ReactDOM }] = await Promise.all([
        import('@axe-core/react'),
        import('react'),
        import('react-dom'),
      ])
      axe(React, ReactDOM, 1000)
    } catch (err) {
      console.warn('axe-core/react unavailable:', err)
    }
  })()
}

createRoot(document.getElementById('root')!).render(<App />)
