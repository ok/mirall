// What the app shell decides from the local profile: show the boot screen, the onboarding screen,
// or the app. Pure, so the precedence is testable without React.
//
// It deliberately does NOT take the query store's `loading`. That flag means "a read is in flight",
// which is raised again by every refetch of an already-settled entry — and the shell gates its
// WHOLE tree on it. Feeding it in unmounts the tree on each re-read, which remounts every hook,
// which re-reads the profile, which raises the flag again. Boot has exactly one question: has an
// answer ever landed. `settled` is that question, and once true it never goes back.

// An answer landed, of either kind. A read that failed still settles: the shell must not sit on the
// boot screen because the profile is unreadable.
// `!= null` rather than `!== null`: this is a pure function over a snapshot, and a caller handing
// it an absent `error` (rather than the store's explicit null) would otherwise settle boot with no
// data at all — which reads as "no profile" and opens onboarding over an identity that exists.
export function profileSettled ({ data, error }) {
  return data !== undefined || error != null
}

export function projectProfile ({ data, error, profileNeeded = false }) {
  const settled = profileSettled({ data, error })
  return {
    profile: data ?? null,
    // A read that failed is treated as "no profile", as the hand-rolled version was: onboarding is
    // the safe answer, because the alternative is a blank app over an unreadable identity.
    needsSetup: profileNeeded || (settled && !data),
    // The worker's profile-needed signal is itself an answer, so it ends boot on its own — it
    // arrives before a read would.
    loading: !profileNeeded && !settled,
  }
}
