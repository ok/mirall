// The worker entrypoints this app will spawn. A specifier is a repo-rooted path the renderer names
// over IPC and main turns into a process, so the list is an allowlist, not a convenience: main
// resolves nothing that is not on it.
//
// The renderer needs to name ONE of them — the worker it talks to. It used to take WORKER_SPECS[0],
// which reads the allowlist as though it were ordered: adding a second entry above it would have
// repointed the renderer's whole IPC channel silently. The allowlist is derived from the name, so
// the two cannot disagree.
export const MAIN_WORKER_SPEC = '/src/worker/main.js'

export const WORKER_SPECS = Object.freeze([MAIN_WORKER_SPEC])
