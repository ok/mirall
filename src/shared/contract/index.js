// The contract package: the vocabulary the renderer, the worker and main all speak. Plain ESM with
// ZERO imports, so esbuild bundles it into the renderer, Bare loads it in the worker, and main
// reaches it through import(). Nothing here may import anything — that constraint is what makes one
// declaration usable from three runtimes, and it is enforced by a test.
export { CODES, CODE_NAMES, EXPECTED_CODES, UNUSED_CODES, INVALID_ARGUMENT } from './errors.js'
export { ARG, REQUESTS, REQUEST_NAMES, UNREFERENCED_REQUESTS } from './requests.js'
export { EVENTS, EVENT_NAMES } from './events.js'
export { AVATAR_MAX_BYTES, NAME_MAX, IPC_MAX_FRAME_BYTES } from './limits.js'
export { FILE_STATUS, BADGE_STATUS, SHARE_FILE_STATUS } from './statuses.js'
export { WORKER_EXIT_UNSTABLE } from './exit-codes.js'
