// The worker entrypoints this app will spawn: an allowlist, not a convenience — main resolves
// nothing that is not on it. The renderer names its worker by MAIN_WORKER_SPEC, never by index:
// the list is unordered, and the allowlist is derived from the name so the two cannot disagree.
export const MAIN_WORKER_SPEC = '/src/worker/main.js'

export const WORKER_SPECS = Object.freeze([MAIN_WORKER_SPEC])
