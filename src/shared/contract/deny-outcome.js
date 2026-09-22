// What a deny did. Approval hands out the content key and cannot be taken back until the key
// rotates, so a deny aimed at a peer who is already a member changes nothing, and says so.

export const DENY_OUTCOME = Object.freeze({
  DENIED: 'denied',
  ALREADY_APPROVED: 'already-approved',
  NOT_APPLICABLE: 'not-applicable',
})

export const DENY_OUTCOMES = Object.freeze(Object.values(DENY_OUTCOME))
