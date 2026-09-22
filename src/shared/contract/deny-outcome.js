// What a deny did. Approval hands out the content key and cannot be revoked — there is no key
// rotation — so a decision on a peer another member already approved changes nothing, and says so:
// the peer keeps access, including to anything shared later. This is the one statement of that
// rule; the sites that act on ALREADY_APPROVED point here.

export const DENY_OUTCOME = Object.freeze({
  DENIED: 'denied',
  ALREADY_APPROVED: 'already-approved',
  NOT_APPLICABLE: 'not-applicable',
})

export const DENY_OUTCOMES = Object.freeze(Object.values(DENY_OUTCOME))
