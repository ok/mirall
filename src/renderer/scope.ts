// The Scope vocabulary is one declaration in the contract package now, imported by the renderer, the
// worker and main alike. This file stays only as the renderer's import path — deleting it would
// churn ~20 call sites for no gain.
export { Scope, scopeMatches } from '../shared/contract/scope.js'
export type { Scope as ScopeValue } from '../shared/contract/scope.js'
