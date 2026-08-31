// The worker's exit codes. Main relays the code verbatim to the renderer, and the respawn policy
// is the only reader — so this is the sole channel distinguishing WHY a worker generation ended.
//
// That distinction is load-bearing. A worker killed mid-operation (an OOM on a very large folder)
// booted fine and earns a fresh respawn budget: booting again is likely to work. A worker that
// exits because its own fault rate crossed the unstable threshold is reporting the opposite —
// it booted, reached ready, and then failed anyway, so a budget that resets on every ready is no
// bound at all. Without a distinct code the two are indistinguishable and the second respawns
// forever.
export const WORKER_EXIT_UNSTABLE = 70
