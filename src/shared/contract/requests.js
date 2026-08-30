// One row per renderer/main -> worker request: the single place a request name and its payload are
// described. The router's validator is driven by `args`, so a field is named once.
//
// kind: 'query' only reads and is safe to retry; 'command' may mutate and is not. Curated from the
// handler bodies rather than the names — files:download reads like a query and is not one.
//
// EVERY FIELD IS OPTIONAL. The validator checks the type of what is present and demands nothing,
// because requiredness needs evidence that every caller supplies the field and that evidence does
// not exist yet: a first pass marked spaceId and shareId required and broke three real flows —
// owned-folder:validate is called with no shareId before the share exists, and owned-folder:preview
// is called with an explicit null. Tighten a field only with its call sites in hand.
//
// There is no hexKey type for the same reason: ownerKey is a plain string at the boundary and can
// legitimately be '' (useFiles builds an optimistic row with an empty owner key), so a format
// assertion here would reject traffic the app already sends.
export const ARG = Object.freeze({
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  array: 'array',
  spaceId: 'spaceId',
  shareId: 'shareId',
  path: 'path',
})

export const REQUESTS = Object.freeze({
  'audit:actors': { kind: 'query', args: {} },
  'audit:configure': { kind: 'command', args: {} },
  'audit:export': { kind: 'command', args: {} },
  'audit:get-config': { kind: 'query', args: {} },
  'audit:list': { kind: 'query', args: {} },
  'audit:purge': { kind: 'command', args: {} },
  'audit:spaces': { kind: 'query', args: {} },
  'audit:stats': { kind: 'query', args: {} },
  'diagnostics:export': { kind: 'query', args: {} },
  'downloads:roots-status': { kind: 'query', args: {} },
  'event:loose-file-fs-event': { kind: 'command', args: {} },
  'event:owned-folder-fs-event': { kind: 'command', args: {} },
  'features:get': { kind: 'query', args: {} },
  'feedback:send': { kind: 'command', args: {
    comment: { type: ARG.string, optional: true },
    email: { type: ARG.string, optional: true },
    screenshot: { type: ARG.string, optional: true },
  } },
  'files:add': { kind: 'command', args: {
    fileName: { type: ARG.string, optional: true },
    filePath: { type: ARG.path, optional: true },
    fileSize: { type: ARG.number, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'files:cancel-download': { kind: 'command', args: { transferId: { type: ARG.string, optional: true } } },
  'files:cancel-publish': { kind: 'command', args: { path: { type: ARG.path, optional: true }, spaceId: { type: ARG.spaceId, optional: true } } },
  'files:discard-partial': { kind: 'command', args: { path: { type: ARG.path, optional: true }, spaceId: { type: ARG.spaceId, optional: true } } },
  'files:download': { kind: 'command', args: {
    ownerKey: { type: ARG.string, optional: true },
    path: { type: ARG.path, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'files:list': { kind: 'query', args: { spaceId: { type: ARG.spaceId, optional: true } } },
  'files:pause-download': { kind: 'command', args: { transferId: { type: ARG.string, optional: true } } },
  'files:remove': { kind: 'command', args: { path: { type: ARG.path, optional: true }, spaceId: { type: ARG.spaceId, optional: true } } },
  'files:reveal': { kind: 'command', args: { path: { type: ARG.path, optional: true }, spaceId: { type: ARG.spaceId, optional: true } } },
  'foreign-folder:cancel-preview': { kind: 'command', args: { previewId: { type: ARG.string, optional: true } } },
  'foreign-folder:get': { kind: 'query', args: {
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'foreign-folder:list-all': { kind: 'query', args: {} },
  'foreign-folder:mount': { kind: 'command', args: {
    mountPath: { type: ARG.path, optional: true },
    ownerKey: { type: ARG.string, optional: true },
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'foreign-folder:preview': { kind: 'command', args: {
    mountPath: { type: ARG.path, optional: true },
    ownerKey: { type: ARG.string, optional: true },
    previewId: { type: ARG.string, optional: true },
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'foreign-folder:set-enabled': { kind: 'command', args: {
    enabled: { type: ARG.boolean, optional: true },
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'foreign-folder:unmount': { kind: 'command', args: {
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'foreign-folder:validate': { kind: 'query', args: {
    mountPath: { type: ARG.path, optional: true },
    shareId: { type: ARG.shareId, optional: true },
  } },
  'members:online': { kind: 'query', args: { spaceId: { type: ARG.spaceId, optional: true } } },
  'mounts:list-all': { kind: 'query', args: {} },
  'network:check-liveness': { kind: 'command', args: {} },
  'network:online-hint': { kind: 'command', args: {} },
  'network:probe-canary': { kind: 'command', args: {} },
  'network:reconnect': { kind: 'command', args: {} },
  'network:set-relays': { kind: 'command', args: {} },
  'network:status:get': { kind: 'query', args: {} },
  'network:test-relay': { kind: 'command', args: {} },
  'owned-folder:cancel-index': { kind: 'command', args: {
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'owned-folder:cancel-preview': { kind: 'command', args: { previewId: { type: ARG.string, optional: true } } },
  'owned-folder:delete': { kind: 'command', args: {
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'owned-folder:get': { kind: 'query', args: {
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'owned-folder:index-status': { kind: 'query', args: {
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'owned-folder:list-all': { kind: 'query', args: {} },
  'owned-folder:mount': { kind: 'command', args: {
    ignore: { type: ARG.array, optional: true },
    mountPath: { type: ARG.path, optional: true },
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'owned-folder:preview': { kind: 'command', args: {
    ignore: { type: ARG.array, optional: true },
    mountPath: { type: ARG.path, optional: true },
    previewId: { type: ARG.string, optional: true },
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'owned-folder:relocate': { kind: 'command', args: {
    mountPath: { type: ARG.path, optional: true },
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'owned-folder:validate': { kind: 'query', args: {
    mountPath: { type: ARG.path, optional: true },
    shareId: { type: ARG.shareId, optional: true },
  } },
  'ping': { kind: 'query', args: {} },
  'profile:get': { kind: 'query', args: {} },
  'profile:set': { kind: 'command', args: {
    avatar: { type: ARG.string, optional: true },
    displayName: { type: ARG.string, optional: true },
  } },
  'serving:detail-subscribe': { kind: 'command', args: { path: { type: ARG.path, optional: true }, spaceId: { type: ARG.spaceId, optional: true } } },
  'serving:detail-unsubscribe': { kind: 'command', args: { path: { type: ARG.path, optional: true }, spaceId: { type: ARG.spaceId, optional: true } } },
  'serving:summary-list': { kind: 'query', args: { spaceId: { type: ARG.spaceId, optional: true } } },
  'setVerbose': { kind: 'command', args: { verbose: { type: ARG.boolean, optional: true } } },
  'settings:set-bandwidth': { kind: 'command', args: {} },
  'settings:set-download-folder': { kind: 'command', args: {} },
  'share:create': { kind: 'command', args: { name: { type: ARG.string, optional: true }, spaceId: { type: ARG.spaceId, optional: true } } },
  'share:delete': { kind: 'command', args: {
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'share:discard-partial': { kind: 'command', args: {
    ownerKey: { type: ARG.string, optional: true },
    relPath: { type: ARG.path, optional: true },
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'share:folder-info': { kind: 'query', args: {
    ownerKey: { type: ARG.string, optional: true },
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'share:list': { kind: 'query', args: { spaceId: { type: ARG.spaceId, optional: true } } },
  'share:list-files': { kind: 'query', args: {
    ownerKey: { type: ARG.string, optional: true },
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'share:read-file': { kind: 'query', args: {
    ownerKey: { type: ARG.string, optional: true },
    relPath: { type: ARG.path, optional: true },
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'share:reveal-file': { kind: 'command', args: {
    ownerKey: { type: ARG.string, optional: true },
    relPath: { type: ARG.path, optional: true },
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'share:reveal-folder': { kind: 'command', args: {
    ownerKey: { type: ARG.string, optional: true },
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'shutdown': { kind: 'command', args: {} },
  'space:approve-member': { kind: 'command', args: {
    publicKey: { type: ARG.string, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'space:create': { kind: 'command', args: { icon: { type: ARG.string, optional: true }, name: { type: ARG.string, optional: true } } },
  'space:deny-member': { kind: 'command', args: {
    publicKey: { type: ARG.string, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'space:invite': { kind: 'command', args: {
    autoAdmit: { type: ARG.boolean, optional: true },
    expiresInMs: { type: ARG.number, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'space:join': { kind: 'command', args: {
    icon: { type: ARG.string, optional: true },
    inviteCode: { type: ARG.string, optional: true },
    name: { type: ARG.string, optional: true },
  } },
  'space:leave': { kind: 'command', args: { spaceId: { type: ARG.spaceId, optional: true } } },
  'space:members': { kind: 'query', args: { spaceId: { type: ARG.spaceId, optional: true } } },
  'space:mirrors': { kind: 'query', args: {
    shareId: { type: ARG.shareId, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'space:pending-requests': { kind: 'query', args: { spaceId: { type: ARG.spaceId, optional: true } } },
  'space:storage-summary': { kind: 'query', args: { spaceId: { type: ARG.spaceId, optional: true } } },
  'space:toggle-favorite': { kind: 'command', args: { spaceId: { type: ARG.spaceId, optional: true } } },
  'space:update': { kind: 'command', args: {
    downloadFolder: { type: ARG.path, optional: true },
    icon: { type: ARG.string, optional: true },
    name: { type: ARG.string, optional: true },
    spaceId: { type: ARG.spaceId, optional: true },
  } },
  'spaces:list': { kind: 'query', args: {} },
  'storage:cleanup': { kind: 'command', args: {} },
  'storage:free-space': { kind: 'query', args: {} },
  'storage:info': { kind: 'query', args: {} },
  'storage:leftover-scan': { kind: 'query', args: {} },
})

export const REQUEST_NAMES = Object.freeze(Object.keys(REQUESTS))

// Handlers with no caller anywhere in src/ or test/. Recorded rather than deleted: removing one is
// a behaviour change and belongs in its own commit. The test asserts this list only shrinks.
export const UNREFERENCED_REQUESTS = Object.freeze([
  'owned-folder:cancel-index',
  'storage:cleanup',
])
