// The worker entrypoints this app will spawn. A specifier is a repo-rooted path the renderer names
// over IPC and main turns into a process, so the list is an allowlist, not a convenience: main
// resolves nothing that is not on it.
export const WORKER_SPECS = Object.freeze(['/src/worker/main.js'])
