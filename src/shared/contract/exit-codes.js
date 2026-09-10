// The worker's exit codes. Main relays the code verbatim and workerRespawn.js is the only reader,
// so this is the sole channel saying WHY a generation ended. Distinct from a kill (an OOM
// mid-operation, which earns a fresh respawn budget): a worker that reached ready and then tripped
// the unstable threshold must not — a budget that resets on every ready is no bound.
export const WORKER_EXIT_UNSTABLE = 70
