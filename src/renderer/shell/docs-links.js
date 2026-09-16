// Deep links into the public documentation. The anchors mirror the section ids on
// mirall.app; the site answers 200 for every path, so a stale anchor lands on the page
// with no scroll rather than failing visibly. docs-links.test.js pins DOCS_ANCHORS to the
// links the UI ships, and DocsTarget is derived from it so a typo fails tsc.
const DOCS_BASE = 'https://mirall.app/docs'

const TUTORIAL_ANCHORS = Object.freeze(/** @type {const} */ (['send-your-first-files']))
const GUIDE_ANCHORS = Object.freeze(/** @type {const} */ (['create-a-space', 'join-a-space', 'fix-a-stuck-join', 'share-files', 'share-a-folder', 'run-your-own-relay']))
const EXPLANATION_ANCHORS = Object.freeze(/** @type {const} */ (['membership-approval', 'spaces-members-availability']))

export const DOCS_ANCHORS = Object.freeze({ tutorials: TUTORIAL_ANCHORS, guides: GUIDE_ANCHORS, explanation: EXPLANATION_ANCHORS })

/** @typedef {{ page: 'hub' } | { page: 'tutorials', anchor: (typeof TUTORIAL_ANCHORS)[number] } | { page: 'guides', anchor: (typeof GUIDE_ANCHORS)[number] } | { page: 'explanation', anchor: (typeof EXPLANATION_ANCHORS)[number] }} DocsTarget */

/** @param {DocsTarget} target */
export function docsUrl(target) {
  if (target.page === 'hub') return DOCS_BASE
  return `${DOCS_BASE}/${target.page}#${target.anchor}`
}
