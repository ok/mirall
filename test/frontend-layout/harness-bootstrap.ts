// What main.tsx does before the first render, minus the app shell: the query store's transport and
// the one reconcile subscription. Without it every query rejects ("no transport configured") and a
// mounted screen renders its empty state, so the harness fails looking for a control that was never
// going to exist. Imported for side effect by EVERY harness entry: the failure is silent, arrives
// whenever a harness later grows a real hook, and CI never runs these.
import { request } from './../../src/renderer/ipc.js'
import { configureQueryStore } from './../../src/renderer/store/query-store.js'
import { installPushBridges, installReconcileBridge } from './../../src/renderer/store/reconcile.js'

configureQueryStore({ request: (type, params, opts) => request(type, params, undefined, opts) })
installReconcileBridge()
installPushBridges()
