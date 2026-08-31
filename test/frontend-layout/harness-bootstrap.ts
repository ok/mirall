// What main.tsx does before the first render, minus the app shell: the query store's transport
// and the single reconcile subscription every store-backed view re-derives from.
//
// A harness that mounts a real screen mounts its real hooks, and those read through the query
// store. Without this the store's transport is the default reject ("query store: no transport
// configured"), so EVERY query fails and the screen renders its empty state — a members panel
// with no members, an approval row with nothing to approve. The harness then fails looking for a
// control that was never going to exist, naming the symptom rather than the cause.
//
// Imported for side effect by every harness entry, not only the ones that mount screens today:
// the failure is silent and arrives whenever a harness later grows a real hook, and these
// harnesses are local-only, so CI never catches the drift.
import { request } from './../../src/renderer/ipc.js'
import { configureQueryStore } from './../../src/renderer/store/query-store.js'
import { installReconcileBridge } from './../../src/renderer/store/reconcile.js'

configureQueryStore({ request: (type, params, opts) => request(type, params, undefined, opts) })
installReconcileBridge()
