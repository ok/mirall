import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.join(here, '..', '..', 'src', 'renderer', 'styles', 'tailwind.css'), 'utf8')

// Avatars could be picked up anywhere and dropped nowhere. Images and links are the elements Chromium
// makes draggable by default; text cannot be, since the app turns selection off.
test('REGRESSION (avatars could be dragged with nowhere to drop): images and links are not draggable', (t) => {
  t.ok(/img,\s*a\s*\{\s*-webkit-user-drag:\s*none;/.test(css), 'tailwind.css turns default dragging off for img and a')
})
