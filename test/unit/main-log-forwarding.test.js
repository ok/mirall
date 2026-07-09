import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

// The failure only manifests inside Electron (webContents + a disposed render frame), so —
// like msix-manager-preload.test.js — this pins the structural invariants in main.js source:
// a failed send must be swallowed per-target, and the log-forwarding console override must
// be re-entrancy-guarded, or Electron's own "Error sending from webFrameMain" log re-enters
// the override, forwards again, fails again — an unbounded loop that hangs main.
const here = path.dirname(fileURLToPath(import.meta.url))
const mainSrc = readFileSync(path.join(here, '..', '..', 'src', 'main', 'main.js'), 'utf8')

function fnBody (name) {
  const m = mainSrc.match(new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}'))
  return m ? m[1] : null
}

test('REGRESSION (FIX-EDA-4: main log forwarding cannot loop on a disposed render frame)', (t) => {
  const sendToAll = fnBody('sendToAll')
  t.ok(sendToAll, 'sendToAll() exists in src/main/main.js')
  t.ok(/try\s*\{\s*wc\.send\(channel,\s*payload\)\s*\}\s*catch\s*\{\}/.test(sendToAll),
    'sendToAll swallows a per-target send failure (disposed render frame) instead of throwing')

  const fwd = fnBody('installMainLogForwarding')
  t.ok(fwd, 'installMainLogForwarding() exists')
  t.ok(/let forwarding = false/.test(fwd), 'declares the re-entrancy flag')
  t.ok(/if\s*\(!debug\s*\|\|\s*forwarding\)\s*return/.test(fwd),
    'the console override bails while a forward is already in flight')
  t.ok(/forwarding = true[\s\S]*finally\s*\{\s*forwarding = false\s*\}/.test(fwd),
    'the flag is set around sendToAll and always restored')
})
