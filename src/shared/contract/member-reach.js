// The vocabulary `members:reach` answers in: how a connected member is reached. Which value a
// person gets, and which members get none, is network/member-reach.js.

export const MEMBER_REACH = Object.freeze({
  DIRECT: 'direct',
  RELAYED: 'relayed',
})

/** @typedef {(typeof MEMBER_REACH)[keyof typeof MEMBER_REACH]} MemberReach */
