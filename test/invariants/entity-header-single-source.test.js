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
  const HEROES = new Set(['SpacesScreen.tsx', 'OnboardingScreen.tsx'])
  // Recursive: the settings pages live in a subfolder, and a non-recursive walk would quietly
  // stop checking seven of them.
  const screenFiles = []
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.isDirectory()) walk(path.join(dir, name.name), `${prefix}${name.name}/`)
      else if (name.name.endsWith('.tsx')) screenFiles.push(prefix + name.name)
    }
  }
  walk(SCREENS)

  let checked = 0
  for (const file of screenFiles) {
    if (HEROES.has(path.basename(file))) continue
    checked++
    t.absent(/<h1/.test(read(file)), `${file}: take the title from PageHeader or EntityHeader`)
  }
  t.ok(checked >= 13, `checked ${checked} screens`)
})

// SpaceScreen reaches EntityHeader through SpaceHeaderBar, which also carries its legacy badge. The
// hop is named here and closed below, so the indirection cannot become a hole.
const SHELLS = new Map([['SpaceScreen.tsx', '../components/layout/SpaceHeaderBar.tsx']])

test('the two name-bearing screens use EntityHeader', (t) => {
  for (const file of ['SpaceScreen.tsx', 'FolderScreen.tsx']) {
    const shell = SHELLS.get(file)
    if (shell) {
      const shellSrc = readFileSync(path.resolve(SCREENS, shell), 'utf8')
      t.ok(read(file).includes(`<${path.basename(shell, '.tsx')}`), `${file} renders its header shell`)
      t.ok(shellSrc.includes('<EntityHeader'), `and ${shell} renders <EntityHeader>`)
      continue
    }
    t.ok(read(file).includes('<EntityHeader'), `${file} renders <EntityHeader>`)
  }
})
