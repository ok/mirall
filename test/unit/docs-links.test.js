import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { docsUrl } from '../../src/renderer/docs-links.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DTS = path.resolve(here, '../../src/renderer/docs-links.d.ts')

// Every link the UI renders, pinned to the exact URL a user lands on.
const SHIPPING_LINKS = [
  [{ page: 'tutorials', anchor: 'send-your-first-files' }, 'https://mirall.app/docs/tutorials#send-your-first-files'],
  [{ page: 'guides', anchor: 'create-a-space' }, 'https://mirall.app/docs/guides#create-a-space'],
  [{ page: 'guides', anchor: 'join-a-space' }, 'https://mirall.app/docs/guides#join-a-space'],
  [{ page: 'guides', anchor: 'fix-a-stuck-join' }, 'https://mirall.app/docs/guides#fix-a-stuck-join'],
  [{ page: 'guides', anchor: 'share-files' }, 'https://mirall.app/docs/guides#share-files'],
  [{ page: 'guides', anchor: 'share-a-folder' }, 'https://mirall.app/docs/guides#share-a-folder'],
  [{ page: 'explanation', anchor: 'membership-approval' }, 'https://mirall.app/docs/explanation#membership-approval'],
  [{ page: 'explanation', anchor: 'spaces-members-availability' }, 'https://mirall.app/docs/explanation#spaces-members-availability'],
]

test('docs-links: every shipping link resolves to its exact URL', (t) => {
  for (const [target, expected] of SHIPPING_LINKS) {
    t.is(docsUrl(target), expected, `${target.page}#${target.anchor}`)
  }
})

test('docs-links: the hub target has no anchor and no trailing slash', (t) => {
  t.is(docsUrl({ page: 'hub' }), 'https://mirall.app/docs')
})

test('docs-links: every URL is https, on mirall.app, under /docs, with one fragment', (t) => {
  for (const [target] of SHIPPING_LINKS) {
    const href = docsUrl(target)
    const url = new URL(href)
    t.is(url.protocol, 'https:', `${href} is https`)
    t.is(url.host, 'mirall.app', `${href} is on the apex`)
    t.ok(url.pathname.startsWith('/docs/'), `${href} is under /docs`)
    t.absent(url.pathname.endsWith('/'), `${href} has no trailing slash before the fragment`)
    t.is((href.match(/#/g) ?? []).length, 1, `${href} has exactly one fragment separator`)
  }
})

// TypeScript never runs over the .js, so the sidecar's unions are only a compile-time
// contract. Read the anchors back out of it and prove the declared set is exactly the set
// the UI ships: a declared-but-unwired anchor and a wired-but-undeclared one both fail.
test('docs-links: the .d.ts declares exactly the anchors the UI ships', (t) => {
  const src = fs.readFileSync(DTS, 'utf8')
  const pages = {
    TutorialAnchor: 'tutorials',
    GuideAnchor: 'guides',
    ExplanationAnchor: 'explanation',
  }
  const declared = []
  for (const [typeName, page] of Object.entries(pages)) {
    const block = src.split(`type ${typeName}`)[1]?.split('\n\n')[0] ?? ''
    const anchors = [...block.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1])
    t.ok(anchors.length > 0, `${typeName} declares at least one anchor`)
    for (const anchor of anchors) {
      t.is(docsUrl({ page, anchor }), `https://mirall.app/docs/${page}#${anchor}`, `${page}#${anchor}`)
      declared.push(`${page}#${anchor}`)
    }
  }
  const shipped = SHIPPING_LINKS.map(([target]) => `${target.page}#${target.anchor}`)
  t.alike(declared.sort(), shipped.sort(), 'no declared-but-unused and no used-but-undeclared anchors')
})
