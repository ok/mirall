import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'locales') walk(p, out) }
    else if (/\.(tsx|ts|js)$/.test(name)) out.push(p)
  }
  return out
}

// A `mirall:` window event is how one part of the renderer used to hand an action to a screen that
// was not mounted yet: navigate, then dispatch on the next macrotask and hope the listener exists by
// then. Nothing retried, so a mount that took a tick longer dropped the action silently. Actions
// aimed at a screen are navigation state now, which simply waits.
//
// The close-modals broadcast is the exception and stays: it goes to whatever happens to be open,
// not to one screen, so reaching no listener is a correct outcome rather than a lost message.
// Matching on the call rather than on the event name is deliberate — the channel this replaced
// named its event through a constant, which a search for the string would have walked straight past.
const BROADCASTER = 'keyboard/KeyboardProvider.tsx'

test('no renderer action is handed over as a window event', (t) => {
  const files = walk(root)
  t.ok(files.length > 100, `walked ${files.length} renderer files`)
  for (const file of files) {
    const rel = path.relative(root, file)
    if (rel === BROADCASTER) continue
    t.absent(/window\.dispatchEvent\s*\(/.test(readFileSync(file, 'utf8')),
      `${rel}: hands an action over as a window event — give the screen navigation state instead`)
  }
})
