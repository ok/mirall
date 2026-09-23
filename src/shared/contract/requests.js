// One row per renderer/main -> worker request: the single place a request name and its payload are
// described. The router's validator is driven by `args`, so a field is named once.
//
// kind: 'query' only reads and is safe to retry; 'command' may mutate and is not. Curated from the
// handler bodies rather than the names — files:download reads like a query and is not one.
//
// A FIELD IS REQUIRED UNLESS THE HANDLER DEFINES WHAT ITS ABSENCE MEANS, and every optional field
// below says why in one clause. "Some caller happens to omit it" is not a reason — that caller is
// fixed. The question is answered by reading the handler, not by grepping call sites: a filter, a
// partial update, a tri-state, or a default the handler supplies are all real absences;
// a field the handler then reads unguarded is not.
//
// `null` counts as missing, which is what makes `owned-folder:preview` sending an explicit
// `shareId: null` a legitimate absence rather than a violation. It also means a field that may be
// the EMPTY STRING can still be required — ownerKey is, because useFiles builds an optimistic row
// with an empty owner key and '' is a value.
//
// `max` is a transport bound, not a domain rule: the deep clamps (identity-limits.js) truncate,
// these refuse, and the two are different behaviours. They sit far above any domain limit.
//
// There is no hexKey type: ownerKey is a plain string at the boundary and can legitimately be '',
// so a format assertion here would reject traffic the app already sends.
import { ARG_MAX } from './limits.js'

/** @typedef {'string' | 'number' | 'boolean' | 'array' | 'object' | 'spaceId' | 'shareId' | 'path'} ArgType */
/** @typedef {{ type: ArgType, optional?: boolean, max?: number }} ArgRule */
// `deadlineMs` is optional and read by contract/request-deadlines.js: a row that omits it takes its
// kind's default, and 0 means the request is deliberately unbounded.
/** @typedef {{ kind: 'query' | 'command', args: Record<string, ArgRule>, deadlineMs?: number }} RequestSpec */
/** @typedef {Record<string, string | number | boolean | readonly string[] | null | undefined>} RequestParams */

/** @internal @satisfies {Readonly<Record<ArgType, ArgType>>} */
export const ARG = Object.freeze({
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  array: 'array',
  object: 'object',
  spaceId: 'spaceId',
  shareId: 'shareId',
  path: 'path',
})

/** @satisfies {Record<string, RequestSpec>} */
export const REQUESTS = Object.freeze({
  'audit:actors': { kind: 'query', args: {} },
  'audit:configure': { kind: 'command', args: {
    enabled: { type: ARG.boolean, optional: true },
    maxEntries: { type: ARG.number, optional: true },
    retentionDays: { type: ARG.number, optional: true },
  } },
  'audit:export': { kind: 'command', deadlineMs: 0, args: {
    since: { type: ARG.number, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
    until: { type: ARG.number, optional: true },
  } },
  'audit:get-config': { kind: 'query', args: {} },
  'audit:list': { kind: 'query', args: {
    actorKey: { type: ARG.string, optional: true, max: ARG_MAX.key },
    categories: { type: ARG.array, optional: true },
    cursor: { type: ARG.number, optional: true },
    kinds: { type: ARG.array, optional: true },
    limit: { type: ARG.number, optional: true },
    search: { type: ARG.string, optional: true, max: ARG_MAX.text },
    since: { type: ARG.number, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
    until: { type: ARG.number, optional: true },
  } },
  'audit:purge': { kind: 'command', args: {} },
  'audit:spaces': { kind: 'query', args: {} },
  'audit:stats': { kind: 'query', args: {} },
  // Unbounded on purpose: this is the request a person makes BECAUSE something is stuck, and it
  // reads the very subsystems that may be stuck. A deadline here fails bundle collection on exactly
  // the worker where the bundle is needed.
  'diagnostics:export': { kind: 'query', deadlineMs: 0, args: { redact: { type: ARG.boolean, optional: true } } },
  'downloads:roots-status': { kind: 'query', args: {} },
  'event:foreign-folder-fs-event': { kind: 'command', args: {
    absPath: { type: ARG.path, max: ARG_MAX.path },
    action: { type: ARG.string, max: ARG_MAX.name },
    relPath: { type: ARG.path, max: ARG_MAX.path },
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'event:loose-file-fs-event': { kind: 'command', args: {
    absPath: { type: ARG.path, max: ARG_MAX.path },
    action: { type: ARG.string, max: ARG_MAX.name },
    spaceId: { type: ARG.spaceId },
  } },
  'event:owned-folder-fs-event': { kind: 'command', args: {
    absPath: { type: ARG.path, max: ARG_MAX.path },
    action: { type: ARG.string, max: ARG_MAX.name },
    relPath: { type: ARG.path, max: ARG_MAX.path },
    shareId: { type: ARG.shareId },
  } },
  'features:get': { kind: 'query', args: {} },
  // A query because it only reads: it writes nothing and a caller may ask again. It is not free of
  // consequence, though — a second call replays frames the first already delivered, and while
  // pokes are level-triggered and the OS notifications are keyed by transfer id, the membership
  // toasts are keyed by nothing and would appear twice. A client resumes once per reconnect.
  'events:resume': { kind: 'query', args: {
    // Both optional, and their absence is the first-time-subscriber case: a client with no epoch
    // has seen nothing, so it has missed nothing and is simply told where the stream is.
    epoch: { type: ARG.string, optional: true, max: ARG_MAX.key },
    since: { type: ARG.number, optional: true },
  } },
  'feedback:send': { kind: 'command', args: {
    // The handler substitutes '(no comment)' — a report with only a screenshot is a real report.
    comment: { type: ARG.string, optional: true, max: ARG_MAX.text },
    email: { type: ARG.string, optional: true, max: ARG_MAX.text },
    screenshot: { type: ARG.string, optional: true },
  } },
  'files:add': { kind: 'command', deadlineMs: 0, args: {
    fileName: { type: ARG.string },
    filePath: { type: ARG.path },
    // Absent means the audit row records no size; the transfer itself never reads it.
    fileSize: { type: ARG.number, optional: true },
    spaceId: { type: ARG.spaceId },
  } },
  'files:cancel-download': { kind: 'command', args: { transferId: { type: ARG.string } } },
  'files:cancel-publish': { kind: 'command', args: { path: { type: ARG.path }, spaceId: { type: ARG.spaceId } } },
  'files:discard-partial': { kind: 'command', args: { path: { type: ARG.path }, spaceId: { type: ARG.spaceId } } },
  'files:download': { kind: 'command', args: {
    ownerKey: { type: ARG.string, max: ARG_MAX.key },
    path: { type: ARG.path, max: ARG_MAX.path },
    spaceId: { type: ARG.spaceId },
  } },
  'files:list': { kind: 'query', args: { spaceId: { type: ARG.spaceId } } },
  'files:pause-download': { kind: 'command', args: { transferId: { type: ARG.string } } },
  'files:remove': { kind: 'command', args: { path: { type: ARG.path }, spaceId: { type: ARG.spaceId } } },
  'files:reveal': { kind: 'command', args: { path: { type: ARG.path }, spaceId: { type: ARG.spaceId } } },
  'foreign-folder:cancel-preview': { kind: 'command', args: { previewId: { type: ARG.string } } },
  'foreign-folder:get': { kind: 'query', args: {
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'foreign-folder:list-all': { kind: 'query', args: {} },
  'foreign-folder:mount': { kind: 'command', args: {
    mountPath: { type: ARG.path, max: ARG_MAX.path },
    ownerKey: { type: ARG.string, max: ARG_MAX.key },
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'foreign-folder:preview': { kind: 'command', deadlineMs: 0, args: {
    mountPath: { type: ARG.path, max: ARG_MAX.path },
    ownerKey: { type: ARG.string, max: ARG_MAX.key },
    previewId: { type: ARG.string, optional: true, max: ARG_MAX.key },
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'foreign-folder:set-enabled': { kind: 'command', args: {
    enabled: { type: ARG.boolean },
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'foreign-folder:relocate': { kind: 'command', args: {
    mountPath: { type: ARG.path, max: ARG_MAX.path },
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'foreign-folder:unmount': { kind: 'command', args: {
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'foreign-folder:validate': { kind: 'query', args: {
    mountPath: { type: ARG.path, max: ARG_MAX.path },
    shareId: { type: ARG.shareId, optional: true },
  } },
  'members:online': { kind: 'query', args: { spaceId: { type: ARG.spaceId } } },
  'members:reach': { kind: 'query', args: { spaceId: { type: ARG.spaceId } } },
  'mounts:list-all': { kind: 'query', args: {} },
  'network:check-liveness': { kind: 'command', args: {} },
  'network:online-hint': { kind: 'command', args: { online: { type: ARG.boolean, optional: true } } },
  'network:probe-canary': { kind: 'command', args: { force: { type: ARG.boolean, optional: true } } },
  'network:reconnect': { kind: 'command', args: {} },
  'network:set-relay': { kind: 'command', args: {
    deferApply: { type: ARG.boolean, optional: true },
    mode: { type: ARG.string, max: ARG_MAX.name },
    relay: { type: ARG.object, optional: true },
  } },
  'network:status:get': { kind: 'query', args: {} },
  'network:test-relay': { kind: 'command', args: { publicKey: { type: ARG.string, max: ARG_MAX.key } } },
  'owned-folder:cancel-preview': { kind: 'command', args: { previewId: { type: ARG.string } } },
  'owned-folder:delete': { kind: 'command', args: {
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'owned-folder:get': { kind: 'query', args: {
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'owned-folder:index-status': { kind: 'query', args: {
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'owned-folder:list-all': { kind: 'query', args: {} },
  'owned-folder:mount': { kind: 'command', args: {
    ignore: { type: ARG.array, optional: true },
    mountPath: { type: ARG.path, max: ARG_MAX.path },
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'owned-folder:pause-index': { kind: 'command', args: {
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'owned-folder:preview': { kind: 'command', deadlineMs: 0, args: {
    ignore: { type: ARG.array, optional: true },
    mountPath: { type: ARG.path, max: ARG_MAX.path },
    previewId: { type: ARG.string, optional: true, max: ARG_MAX.key },
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId },
  } },
  'owned-folder:relocate': { kind: 'command', args: {
    mountPath: { type: ARG.path, max: ARG_MAX.path },
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'owned-folder:resume-index': { kind: 'command', args: {
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'owned-folder:validate': { kind: 'query', args: {
    mountPath: { type: ARG.path, max: ARG_MAX.path },
    shareId: { type: ARG.shareId, optional: true },
  } },
  'ping': { kind: 'query', args: {} },
  'profile:get': { kind: 'query', args: {} },
  'profile:set': { kind: 'command', args: {
    avatar: { type: ARG.string, optional: true },
    displayName: { type: ARG.string, max: ARG_MAX.name },
  } },
  'serving:detail-subscribe': { kind: 'command', args: { path: { type: ARG.path }, spaceId: { type: ARG.spaceId } } },
  'serving:detail-unsubscribe': { kind: 'command', args: { path: { type: ARG.path }, spaceId: { type: ARG.spaceId } } },
  'serving:summary-list': { kind: 'query', args: { spaceId: { type: ARG.spaceId } } },
  'setVerbose': { kind: 'command', args: { verbose: { type: ARG.boolean } } },
  'settings:set-bandwidth': { kind: 'command', args: {
    downloadKBps: { type: ARG.number, optional: true },
    uploadKBps: { type: ARG.number, optional: true },
  } },
  'settings:set-download-folder': { kind: 'command', args: { folder: { type: ARG.path, optional: true, max: ARG_MAX.path } } },
  'share:create': { kind: 'command', args: { name: { type: ARG.string }, spaceId: { type: ARG.spaceId } } },
  'share:create-and-mount': { kind: 'command', args: {
    ignore: { type: ARG.array, optional: true },
    mountPath: { type: ARG.path, max: ARG_MAX.path },
    name: { type: ARG.string, max: ARG_MAX.name },
    spaceId: { type: ARG.spaceId },
  } },
  'share:delete': { kind: 'command', args: {
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'share:rename': { kind: 'command', args: {
    name: { type: ARG.string, max: ARG_MAX.name },
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'share:discard-partial': { kind: 'command', args: {
    ownerKey: { type: ARG.string, max: ARG_MAX.key },
    relPath: { type: ARG.path, max: ARG_MAX.path },
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'share:folder-info': { kind: 'query', args: {
    ownerKey: { type: ARG.string, max: ARG_MAX.key },
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'share:list': { kind: 'query', args: { spaceId: { type: ARG.spaceId } } },
  'share:list-files': { kind: 'query', deadlineMs: 60000, args: {
    ownerKey: { type: ARG.string, max: ARG_MAX.key },
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  // A query by row, but it writes a durable pending row and reserves a transfer slot before it
  // returns, so the "a query is retry-safe, abort it" rule does not hold for this one. Opted out
  // rather than reclassified: `kind` is wire vocabulary other things read.
  'share:read-file': { kind: 'query', deadlineMs: 0, args: {
    ownerKey: { type: ARG.string, max: ARG_MAX.key },
    relPath: { type: ARG.path, max: ARG_MAX.path },
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'share:reveal-file': { kind: 'command', args: {
    ownerKey: { type: ARG.string, max: ARG_MAX.key },
    relPath: { type: ARG.path, max: ARG_MAX.path },
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'share:reveal-folder': { kind: 'command', args: {
    ownerKey: { type: ARG.string, max: ARG_MAX.key },
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'shutdown': { kind: 'command', args: {} },
  'space:approve-member': { kind: 'command', args: {
    publicKey: { type: ARG.string, max: ARG_MAX.key },
    spaceId: { type: ARG.spaceId },
  } },
  // icon is optional: createSpace supplies its own default when a caller omits one.
  'space:create': { kind: 'command', args: {
    icon: { type: ARG.string, optional: true, max: ARG_MAX.name },
    name: { type: ARG.string, max: ARG_MAX.name },
  } },
  'space:deny-member': { kind: 'command', args: {
    publicKey: { type: ARG.string, max: ARG_MAX.key },
    spaceId: { type: ARG.spaceId },
  } },
  'space:invite': { kind: 'command', args: {
    autoAdmit: { type: ARG.boolean, optional: true },
    expiresInMs: { type: ARG.number, optional: true },
    spaceId: { type: ARG.spaceId },
  } },
  'space:join': { kind: 'command', args: {
    icon: { type: ARG.string, optional: true, max: ARG_MAX.name },
    inviteCode: { type: ARG.string, max: ARG_MAX.text },
    name: { type: ARG.string, optional: true, max: ARG_MAX.name },
  } },
  'space:leave': { kind: 'command', deadlineMs: 0, args: { spaceId: { type: ARG.spaceId } } },
  'space:members': { kind: 'query', args: { spaceId: { type: ARG.spaceId } } },
  'space:mirrors': { kind: 'query', args: {
    shareId: { type: ARG.shareId },
    spaceId: { type: ARG.spaceId },
  } },
  'space:pending-requests': { kind: 'query', args: { spaceId: { type: ARG.spaceId } } },
  'space:storage-summary': { kind: 'query', args: { spaceId: { type: ARG.spaceId } } },
  'space:toggle-favorite': { kind: 'command', args: { spaceId: { type: ARG.spaceId } } },
  'space:update': { kind: 'command', args: {
    downloadFolder: { type: ARG.path, optional: true, max: ARG_MAX.path },
    icon: { type: ARG.string, optional: true, max: ARG_MAX.name },
    name: { type: ARG.string, optional: true, max: ARG_MAX.name },
    spaceId: { type: ARG.spaceId },
  } },
  'spaces:list': { kind: 'query', args: {} },
  'storage:info': { kind: 'query', args: {} },
})

/** @internal the declaration-parity guard's list; production reads the table above it */
export const REQUEST_NAMES = Object.freeze(/** @type {RequestName[]} */ (Object.keys(REQUESTS)))
/** @typedef {keyof typeof REQUESTS} RequestName */

// Handlers with no caller anywhere in src/ or test/. Recorded rather than deleted: removing one is
// a behaviour change and belongs in its own commit. The test asserts this list only shrinks.
/** @internal the declaration-parity guard's allow-list @type {readonly RequestName[]} */
export const UNREFERENCED_REQUESTS = Object.freeze([])
