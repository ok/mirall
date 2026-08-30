// The audit vocabulary is one declaration in the contract package now. This file remains as the
// renderer's import path; the hand-maintained twin it used to hold — and the test that watched the
// two lists for divergence — are gone, because divergence is no longer representable.
//
// The renderer needs the kind names so a search term typed in any locale can be matched against the
// TRANSLATED labels and turned into a `kinds` filter: the stored search blob is proper nouns only.
import { KINDS } from '../shared/contract/audit-kinds.js'

export { KINDS, CATEGORY, CATEGORIES, isKnownKind, categoryOf, tierOf } from '../shared/contract/audit-kinds.js'

export const AUDIT_KINDS: readonly string[] = Object.keys(KINDS)
