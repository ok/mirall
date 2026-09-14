// The swarm-facing tests exercise the swarm, not the overlay; the backend is a dep they must supply
// and never assert on. Kept here rather than inline so the shape follows the real backend's
// surface: a method the backend gains and this omits fails as "not a function" at the call site,
// not as a missing stub two files away.
export const stubOverlayBackend = {
  attach() {},
  detach: async () => {},
  resumeForOwner() {},
  resumeForOwnerAllSpaces() {},
  revokeServesForSpace() {},
}
