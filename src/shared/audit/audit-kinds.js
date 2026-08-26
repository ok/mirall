// The closed audit vocabulary. A kind absent from this table is refused at write time — the
// log's value depends on the vocabulary being reviewed rather than accreted. `category` drives
// the viewer's filter; `tier` is the attribution confidence recorded with every row:
//   A — first-party: this install did it.
//   B — a peer action attributable through the handshake identity binding, or a Noise-authenticated
//       socket (handshake / membership frames, overlay serve requests).
//   C — derived from a peer's replicated bee: authorship is proven, but the timestamp is the
//       author's own clock.
// There is no tier D: what a peer does with bytes after receipt, and transfers between two
// other members, are unobservable here (overlay transfers are point-to-point — only the holder
// sees them).
export const CATEGORY = {
  MEMBERS: 'members',
  FILES: 'files',
  FOLDERS: 'folders',
  SECURITY: 'security',
  NETWORK: 'network',
}

export const KINDS = {
  'space.created': { category: CATEGORY.MEMBERS, tier: 'A' },
  'space.joined': { category: CATEGORY.MEMBERS, tier: 'A' },
  'space.updated': { category: CATEGORY.MEMBERS, tier: 'A' },
  'space.left': { category: CATEGORY.MEMBERS, tier: 'A' },
  'invite.minted': { category: CATEGORY.MEMBERS, tier: 'A' },
  'membership.requested': { category: CATEGORY.MEMBERS, tier: 'B' },
  'membership.approved': { category: CATEGORY.MEMBERS, tier: 'A' },
  'membership.denied': { category: CATEGORY.MEMBERS, tier: 'A' },
  'membership.granted': { category: CATEGORY.MEMBERS, tier: 'B' },
  // NOT an eject: this device withdrawing its own vouch, which in practice follows from
  // observing a leave. The app has no member-removal capability — approvals are grow-only in
  // the OR-Set fold, and the space content key is already handed out — so copy for this kind
  // must never imply someone was removed.
  'membership.approval_revoked': { category: CATEGORY.MEMBERS, tier: 'C' },
  'member.joined': { category: CATEGORY.MEMBERS, tier: 'B' },
  'member.left': { category: CATEGORY.MEMBERS, tier: 'B' },
  'file.shared': { category: CATEGORY.FILES, tier: 'A' },
  'file.unshared': { category: CATEGORY.FILES, tier: 'A' },
  'transfer.completed': { category: CATEGORY.FILES, tier: 'A' },
  'transfer.failed': { category: CATEGORY.FILES, tier: 'A' },
  'serve.completed': { category: CATEGORY.FILES, tier: 'B' },
  // Tier C throughout: read from a peer's own replicated records. Authorship is proven by the bee
  // signature, but the timing is their clock, and we only learn of it when their append reaches us.
  'peer.file_shared': { category: CATEGORY.FILES, tier: 'C' },
  'peer.file_unshared': { category: CATEGORY.FILES, tier: 'C' },
  'share.created': { category: CATEGORY.FOLDERS, tier: 'A' },
  'share.deleted': { category: CATEGORY.FOLDERS, tier: 'A' },
  'share.mounted': { category: CATEGORY.FOLDERS, tier: 'A' },
  'share.relocated': { category: CATEGORY.FOLDERS, tier: 'A' },
  'mirror.created': { category: CATEGORY.FOLDERS, tier: 'A' },
  'mirror.removed': { category: CATEGORY.FOLDERS, tier: 'A' },
  'peer.share_created': { category: CATEGORY.FOLDERS, tier: 'C' },
  'peer.share_deleted': { category: CATEGORY.FOLDERS, tier: 'C' },
  'mirror.peer_mirrored': { category: CATEGORY.FOLDERS, tier: 'C' },
  'mirror.peer_unmirrored': { category: CATEGORY.FOLDERS, tier: 'C' },
  'security.serve_denied': { category: CATEGORY.SECURITY, tier: 'B' },
  'security.integrity_failure': { category: CATEGORY.SECURITY, tier: 'A' },
  'security.creator_divergence': { category: CATEGORY.SECURITY, tier: 'B' },
  'audit.suppressed': { category: CATEGORY.SECURITY, tier: 'A' },
  // The log's negative space. Every kind above records something that HAPPENED, and the questions a
  // reader brings are usually about what didn't — a file that never arrived, a member who never
  // appeared. Those produce no rows at all, so silence reads as "the other side did nothing". These
  // are the one record that turns it into "nothing could happen, and here is the window", which is
  // why they clear the bar the app-housekeeping kinds below do not.
  //
  // Tier A: measured on this device, by this install.
  'network.offline': { category: CATEGORY.NETWORK, tier: 'A' },
  'network.blocked': { category: CATEGORY.NETWORK, tier: 'A' },
  'network.at_risk': { category: CATEGORY.NETWORK, tier: 'A' },
  'network.restored': { category: CATEGORY.NETWORK, tier: 'A' },
  // Tier B: the socket is Noise-authenticated and the identity bound through the handshake. NOT a
  // membership change — member.left covers leaving — and written only while OUR OWN connectivity is
  // healthy, because a blocked device makes every peer look gone.
  'network.peer_lost': { category: CATEGORY.NETWORK, tier: 'B' },
  'network.peer_back': { category: CATEGORY.NETWORK, tier: 'B' },
}

// Also absent, because nothing can currently produce them: `invite.revoked` (the only revoke
// path is the expiry sweep — housekeeping, not a user act) and `share.unmounted` (an owned folder
// is removed through owned-folder:delete, already covered by share.deleted). A kind that can
// never fire is worse than a missing one: it still appears in the search labels and the i18n
// catalogue.
//
// Also absent: `network.unknown` — an unknown verdict means boot, suspend, or a consensus still
// forming, so it would put one contentless row in the log per app launch. And no canary kind:
// reachability.js's governing rule is that a canary failure is indistinguishable from OUR seeder
// being down, so it may confirm a verdict but never create one — a row would blame the user for
// our outage.
//
// Deliberately absent: app.updated, app.worker_crashed, storage.cleanup,
// settings.download_folder, feedback.sent — app housekeeping, not "which user did what in a
// space". Also absent: any per-file folder-sync record. The deliberate act is mounting the
// folder (share.mounted carries fileCount + totalBytes); the recurring reconcile and the
// watcher's per-file publishes produce no rows at all.

export const CATEGORIES = Object.values(CATEGORY)

export function isKnownKind(kind) {
  return Object.hasOwn(KINDS, kind)
}

// No fallback on either accessor: buildRecord rejects an unknown kind before these are
// reached, and a silent default would let a typo'd kind land in a bucket the viewer's filter
// can never surface.
export function categoryOf(kind) {
  return KINDS[kind].category
}

export function tierOf(kind) {
  return KINDS[kind].tier
}
