import test from 'brittle'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCREENS = path.resolve(here, '../../src/renderer/screens')
const read = (file) => readFileSync(path.join(SCREENS, file), 'utf8')

// A screen title is one of exactly two things: a settings page's fixed heading (PageHeader) or the
// name of the thing on screen (EntityHeader). The second needs truncate + leading-tight + pb-1.5, or
// the 800-weight headline's descenders are clipped by its own overflow:hidden — a silent failure,
// visible only as a shaved "g". A third screen writing its own <h1> is how that comes back.
test('no screen declares its own page title', (t) => {
  // Two heroes, both centred, neither with a back button or an actions cluster, both at a size no
  // other screen uses.
  const HEROES = new Set(['SharedSpaces.tsx', 'Onboarding.tsx'])
  let checked = 0
  for (const file of readdirSync(SCREENS)) {
    if (!file.endsWith('.tsx') || HEROES.has(file)) continue
    checked++
    t.absent(/<h1/.test(read(file)), `${file}: take the title from PageHeader or EntityHeader`)
  }
  t.ok(checked >= 13, `checked ${checked} screens`)
})

test('the two name-bearing screens use EntityHeader', (t) => {
  for (const file of ['SpaceView.tsx', 'FolderView.tsx']) {
    t.ok(read(file).includes('<EntityHeader'), `${file} renders <EntityHeader>`)
  }
})
