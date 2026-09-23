import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..', 'src', 'renderer')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'locales') walk(p, out) }
    else if (/\.(tsx|ts|js)$/.test(name)) out.push(p)
  }
  return out
}

// One general check rather than a file per primitive: a new screen is covered without anyone
// remembering to add a guard for it. Each rule names the primitive that owns the shape, so the
// failure tells you what to use instead of only what not to write.
//
// `owner` is the file allowed to contain the shape — it is the implementation. `exempt` lists the
// files that legitimately cannot use the primitive, each with the reason.
const RULES = [
  {
    what: 'the focus ring',
    use: 'the `focus-ring` utility',
    owner: 'styles/tailwind.css',
    pattern: /focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary\/30/,
  },
  {
    what: 'an inline error',
    use: '<InlineError>',
    owner: 'components/primitives/InlineError.tsx',
    pattern: /role="alert"[^>]*\btext-error\b|\btext-error\b[^>]*role="alert"/,
    // The file card's error rides INSIDE the meta paragraph, so the row keeps its resting height.
    // InlineError renders a <p>, and a <p> inside a <p> is invalid markup.
    exempt: ['components/cards/FileCard.tsx'],
  },
  {
    what: 'a field label',
    use: '<FieldLabel>',
    owner: 'components/primitives/FieldLabel.tsx',
    pattern: /font-headline text-sm font-bold text-accent px-1/,
  },
  {
    what: 'a field surface',
    use: '<TextField>, or the FIELD_SURFACE it exports',
    owner: 'components/primitives/TextField.tsx',
    pattern: /bg-surface-container-low border-none focus-ring rounded-xl px-6 py-4/,
  },
  {
    what: 'an avatar stack',
    use: '<AvatarStack>',
    owner: 'components/primitives/AvatarStack.tsx',
    pattern: /-space-x-3|-ml-3/,
  },
  {
    what: 'a modal footer row',
    use: '<ModalFooter>',
    owner: 'components/layout/ModalFooter.tsx',
    pattern: /justify-end gap-3|gap-4 \[&>\*\]:flex-1/,
  },
  {
    what: 'a destructive confirm dialog',
    use: '<ConfirmDestructiveModal>',
    owner: 'components/modals/ConfirmDestructiveModal.tsx',
    pattern: /role="alertdialog"/,
    exempt: [
      // Declares the role as a Modal prop — it is the element the primitive configures.
      'components/primitives/Modal.tsx',
    ],
  },
]

test('no renderer file hand-rolls what a primitive owns', (t) => {
  const files = walk(root)
  t.ok(files.length > 100, `walked ${files.length} renderer files`)

  for (const rule of RULES) {
    for (const file of files) {
      const rel = path.relative(root, file)
      if (rel === rule.owner || rule.exempt?.includes(rel)) continue
      t.absent(rule.pattern.test(readFileSync(file, 'utf8')),
        `${rel} builds ${rule.what} itself — use ${rule.use}`)
    }
  }
})

// The rules above are only worth having if they still match the thing they describe. A pattern that
// has rotted past its shape passes everywhere, which is indistinguishable from compliance.
test('every rule still matches the primitive it guards', (t) => {
  for (const rule of RULES) {
    const owner = readFileSync(path.join(root, rule.owner), 'utf8')
    t.ok(rule.pattern.test(owner), `the ${rule.what} pattern matches ${rule.owner}`)
  }
})
