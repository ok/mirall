import test from 'brittle'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { deriveFolderCommands } from '../../src/renderer/folderCommands.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROLES = ['mine', 'mirrored', 'browse']
const BOOL = [false, true]

function each (fn) {
  for (const role of ROLES) {
    for (const paused of BOOL) {
      for (const sourceMissing of BOOL) {
        for (const canMirror of BOOL) {
          fn({ role, paused, sourceMissing, canMirror })
        }
      }
    }
  }
}

test('a browsed folder offers only the mirror act', (t) => {
  each((input) => {
    if (input.role !== 'browse') return
    const c = deriveFolderCommands(input)
    const label = JSON.stringify(input)
    t.is(c.mirror.available, input.canMirror, `mirror follows canMirror ${label}`)
    t.absent(c.open.available, `no open ${label}`)
    t.absent(c.locate.available, `no locate ${label}`)
    t.absent(c.toggleSync.available, `no pause/resume ${label}`)
    t.absent(c.edit.available, `no edit ${label}`)
  })
})

test('mirror is never offered on a folder you own or already mirror', (t) => {
  each((input) => {
    if (input.role === 'browse') return
    t.absent(deriveFolderCommands(input).mirror.available, `no mirror ${JSON.stringify(input)}`)
  })
})

// The point of the whole design: sync is a toggle, so it is offered in both directions rather
// than listed-but-dead in one of them. A regression here reintroduces the disabled row.
test('pause/resume is offered whichever way the folder is currently set', (t) => {
  each((input) => {
    if (input.role === 'browse') return
    const c = deriveFolderCommands(input)
    t.ok(c.toggleSync.available, `offered ${JSON.stringify(input)}`)
    t.is(
      c.toggleSync.labelKey,
      input.paused ? 'shortcuts.folderResume' : 'shortcuts.folderPause',
      `label swings on paused ${JSON.stringify(input)}`,
    )
  })
})

test('open and locate are exclusive: a folder is opened or found, never both', (t) => {
  each((input) => {
    if (input.role === 'browse') return
    const c = deriveFolderCommands(input)
    t.absent(c.open.available && c.locate.available, `not both ${JSON.stringify(input)}`)
    if (input.role === 'mine') {
      t.ok(c.open.available || c.locate.available, `always one ${JSON.stringify(input)}`)
      t.is(c.locate.available, input.sourceMissing, `locate follows sourceMissing ${JSON.stringify(input)}`)
    } else {
      // A mirror has no mount point of its own to go looking for.
      t.absent(c.locate.available, `mirror never locates ${JSON.stringify(input)}`)
    }
  })
})

test('editing stays available on any folder that is not browse-only', (t) => {
  each((input) => {
    t.is(deriveFolderCommands(input).edit.available, input.role !== 'browse', JSON.stringify(input))
  })
})

test('every label key the folder commands can emit is translated in English', (t) => {
  const en = JSON.parse(readFileSync(join(root, 'src', 'renderer', 'locales', 'en', 'common.json'), 'utf8'))
  const keys = new Set()
  each((input) => {
    for (const spec of Object.values(deriveFolderCommands(input))) keys.add(spec.labelKey)
  })
  t.is(keys.size, 6, 'six distinct labels across the matrix')
  for (const key of keys) {
    const value = key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), en)
    t.ok(typeof value === 'string' && value.length > 0, `${key} is translated`)
    t.ok(value.includes('{{name}}'), `${key} names the folder it acts on`)
  }
})
