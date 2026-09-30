// Whether this build can serve a share's bytes. Every share moves bytes through the overlay
// (served straight from the source file, no second copy). Any other contentMode — absent, an
// 'eager'/'deferred' mode written by older releases, or an unknown future one — is rendered as
// unavailable, never routed.
export const isServableShare = (share) => share?.contentMode === 'overlay'
