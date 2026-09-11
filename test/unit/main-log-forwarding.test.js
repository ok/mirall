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

function fnBody(name) {
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
  t.ok(/if\s*\(!isDebug\(\)\s*\|\|\s*forwarding\)\s*return/.test(fwd),
    'the console override bails while a forward is already in flight')
  // The ring is written before the gate is consulted. That ordering is what lets the forwarding be
  // installed before main knows whether this is a debug run, which is in turn what gets the argv
  // warnings into the ring — they are emitted while the gate still reads false.
  t.ok(/logRing\.push\([\s\S]*?\n\s*if\s*\(!isDebug\(\)/.test(fwd),
    'the log ring is written unconditionally, ahead of the forwarding gate')
  t.ok(/forwarding = true[\s\S]*finally\s*\{\s*forwarding = false\s*\}/.test(fwd),
    'the flag is set around sendToAll and always restored')
})

test('REGRESSION (FIX-ARGV-RING-1): the argv warnings are emitted after the console is captured', (t) => {
  // installMainLogForwarding patches console; anything logged before it runs reaches the terminal
  // and nothing else — not the log ring, so not the diagnostics bundle either. The argv warning
  // loop was the one statement on the wrong side of it, and it is the only line that names which
  // argument was dropped when a deep link fails to parse.
  const install = mainSrc.search(/^installMainLogForwarding\(\)$/m)
  const warnings = mainSrc.search(/^for \(const w of boot\.warnings\)/m)
  t.ok(install >= 0, 'the install call site exists')
  t.ok(warnings >= 0, 'the argv warning loop exists')
  t.ok(install < warnings, 'the console is captured before the warnings are emitted')
})

// StringDecoder.write() returns '' for a chunk that completes no character — it holds the bytes for
// the next one. The handlers wrote their prefix regardless, so a split character produced a bare
// '[worker stderr] ' with no newline that the next real line then continued, in the terminal and in
// any captured build log. The raw forward must NOT move behind that guard: the renderer decodes the
// bytes itself, and a chunk carrying only a split character is the one it needs most.
test('a chunk that decodes to nothing prints nothing, and is still forwarded', (t) => {
  for (const stream of ['stdout', 'stderr']) {
    const m = mainSrc.match(new RegExp(`worker\\.${stream}\\.on\\('data'[\\s\\S]*?\\n  \\}\\)`))
    t.ok(m, `the ${stream} handler exists`)
    const body = m[0]
    const forward = body.indexOf('sendToAll')
    const decode = body.indexOf(`${stream}Decoder.write`)
    t.ok(forward !== -1 && forward < decode, `${stream}: the raw chunk is forwarded before any decode`)
    t.ok(/if \(!text\) return/.test(body), `${stream}: an empty decode prints nothing`)
  }

  // And whatever the decoders still hold at process death is flushed, rather than dropped with the
  // last line the worker wrote.
  const exit = mainSrc.slice(mainSrc.indexOf("worker.once('exit'"))
  t.ok(/stdoutDecoder\.end\(\)/.test(exit) && /stderrDecoder\.end\(\)/.test(exit),
    'both decoders are flushed on worker exit')
})
