import crypto from 'crypto'

// Mirall runs in two identity modes: legacy seed-derivation (the tests' historical
// default) and identity-at-rest (MIR-02 — the PRODUCTION default), where cores open
// from an M-derived keypair and, crucially, the own drive is built over the ROOT
// corestore. Destructive/lifecycle flows (leave, purge, reclaim) behave differently
// across the two — drive teardown that is harmless on a namespaced seed-mode drive
// can close the root in identity mode — so they must be exercised in BOTH. Each peer
// gets a fresh KEK so identities stay independent across launches.
export const MODES = [
  { name: 'seed', flags: () => ({}) },
  { name: 'identity', flags: () => ({ identityKEK: crypto.randomBytes(32).toString('hex') }) },
]
