// Deep links into the public documentation. The anchors mirror the section ids on
// mirall.app; the site answers 200 for every path, so a stale anchor lands on the page
// with no scroll rather than failing visibly. The unions in docs-links.d.ts are the guard.
const DOCS_BASE = 'https://mirall.app/docs'

export function docsUrl (target) {
  if (target.page === 'hub') return DOCS_BASE
  return `${DOCS_BASE}/${target.page}#${target.anchor}`
}
