// What main.tsx does before the first render, minus the app shell: the query store's transport, the
// main-store bridge, and the reconcile subscriptions. Without it every query rejects ("no transport
// configured") and a mounted screen renders its empty state, so the harness fails looking for a
// control that was never going to exist; a main fact never settles at all, so the control that
// reads one sits on its loading shape forever. Imported for side effect by EVERY harness entry: the failure is silent, arrives
// whenever a harness later grows a real hook, and CI never runs these.
import { request } from './../../src/renderer/ipc.js'
import { configureQueryStore } from './../../src/renderer/store/query-store.js'
import { configureMainStore, installMainPushBridge } from './../../src/renderer/store/main-store.js'
import { installPushBridges, installReconcileBridge } from './../../src/renderer/store/reconcile.js'

configureQueryStore({ request: (type, params, opts) => request(type, params, undefined, opts) })
configureMainStore(window.bridge)
installMainPushBridge()
installReconcileBridge()
installPushBridges()
