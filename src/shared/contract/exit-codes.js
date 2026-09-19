// The worker's exit codes. Main relays the code verbatim and workerRespawn.js is the only reader,
// so this is the sole channel saying WHY a generation ended. Distinct from a kill (an OOM
// mid-operation, which earns a fresh respawn budget): a worker that reached ready and then tripped
// the unstable threshold must not — a budget that resets on every ready is no bound.
export const WORKER_EXIT_UNSTABLE = 70

// A bootstrap the worker refused: the host speaks a protocol version outside this build's window.
// Respawning cannot fix it — the next generation reads the same frame — so the renderer's policy
// treats this as terminal rather than spending the budget discovering that five times.
export const WORKER_EXIT_PROTOCOL_MISMATCH = 71

// The last client went away and nothing can connect a new one. Distinct from a clean stop so a log
// reader — and the respawn policy — can tell "the host asked us to stop" from "the host vanished".
export const WORKER_EXIT_ORPHANED = 72
