import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import path from 'path'
import { createMainRequestRouter } from '../../src/main/main-requests.js'
import { MAIN_REQUEST, MAIN_REQUEST_NAMES, MAIN_REQUEST_FRAME } from '../../src/shared/contract/main-requests.js'
import { parseSource, forEachNode, staticString, calleeName } from '../helpers/ast-scan.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', '..', 'src')

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// Parsed, not matched. The guard this replaces used a regex with a 200-character window between
// the frame's opening brace and `command:` — so an emit site carrying an explanatory comment above
// the command, the house style throughout src/worker, was invisible to it, and both parity tests
// below passed while an unrouted command shipped. test/helpers/emit-sites.js records the same
// lesson from the event taxonomy: a parser has no opinion about punctuation, spacing or comments.
function commandOf (frame) {
  // A frame assembled elsewhere (`const f = {…}; emit(MAIN_REQUEST_FRAME, f)`) is not readable
  // here. Reported rather than skipped: an unreadable site is exactly how a command escapes.
  if (!frame || frame.type !== 'ObjectExpression') return { opaque: true }

  for (const prop of frame.properties) {
    if (prop.type !== 'Property') continue
    const key = prop.computed ? staticString(prop.key) : (prop.key.name ?? staticString(prop.key))
    if (key !== 'command') continue
    const v = prop.value
    if (v.type === 'MemberExpression' && v.object.name === 'MAIN_REQUEST') {
      return { constant: v.property.name ?? staticString(v.property) }
    }
    // Both spellings on purpose: a hand-written literal must be found too, or the vocabulary is
    // bypassed by writing the old string back in.
    return { literal: staticString(v) ?? null, opaque: staticString(v) === null }
  }
  return { opaque: true }
}

function emitSites () {
  const sites = []
  for (const file of walk(SRC)) {
    // POSIX separators: path.join yields 'src\\worker\\main.js' on win32, which matched neither
    // filter — the scan found nothing at all and the floor below turned that into six red asserts.
    const rel = path.relative(SRC, file).split(path.sep).join('/')
    if (!(rel.startsWith('worker/') || rel.startsWith('shared/'))) continue
    if (rel.startsWith('shared/contract/')) continue

    const source = readFileSync(file, 'utf8')
    const { ast, visitorKeys } = parseSource(source, file)
    forEachNode(ast, visitorKeys, (node) => {
      if (node.type !== 'CallExpression') return
      if (calleeName(node.callee) !== 'emit') return
      const arg = node.arguments[0]
      const named = arg?.type === 'Identifier' ? arg.name === 'MAIN_REQUEST_FRAME' : staticString(arg) === MAIN_REQUEST_FRAME
      if (!named) return
      sites.push({ file, constant: null, literal: null, opaque: false, ...commandOf(node.arguments[1]) })
    })
  }
  return sites
}

function stubDeps () {
  const calls = []
  return {
    calls,
    deps: {
      ownedFolderWatchers: {
        startWatcher: (...a) => calls.push(['startWatcher', ...a]),
        stopWatcher: (...a) => calls.push(['stopWatcher', ...a]),
      },
      looseFileWatchers: {
        addLooseWatch: (...a) => calls.push(['addLooseWatch', ...a]),
        removeLooseWatch: (...a) => calls.push(['removeLooseWatch', ...a]),
      },
      setDownloadRoots: (roots) => calls.push(['setDownloadRoots', roots]),
      sendToWorker: (_worker, frame) => calls.push(['sendToWorker', frame]),
    },
  }
}

function muteWarn (t) {
  const original = console.warn
  const lines = []
  console.warn = (...args) => lines.push(args.join(' '))
  t.teardown(() => { console.warn = original })
  return lines
}

// REGRESSION (FIX-H3-1: handleMainRequest was five `if (command === …) return` blocks with nothing
// after them, so an unrecognised command resolved undefined and the caller's .catch never fired.
// A half-finished rename would arm no watcher on any owned folder, on every peer, silently.)
test('REGRESSION (FIX-H3-1): an unknown main-request command is refused loudly, not silently ignored', async (t) => {
  const warnings = muteWarn(t)
  const { calls, deps } = stubDeps()
  const router = createMainRequestRouter(deps)

  await router.handle('owned-folder:watch', { shareId: 's1', mountPath: '/tmp/x' })

  t.alike(calls, [], 'nothing was done')
  t.ok(warnings.some((l) => l.includes('owned-folder:watch')), 'and it reaches the log ring unconditionally')
})

// REGRESSION (FIX-R1: the dispatch table was a plain object literal, so `handlers[command]` walked
// Object.prototype. 'toString' and 'constructor' found a function there, `!fn` was false, and the
// call resolved as though routed — the same silent success FIX-H3-1 removed, reintroduced through
// the lookup. 'valueOf' and '__proto__' instead threw a TypeError main only logs behind `debug`.
// Command names arrive on the worker pipe, so the table must not have a prototype at all.)
test('REGRESSION (FIX-R1): a command named after an Object.prototype key is unknown, not routed', async (t) => {
  const warnings = muteWarn(t)
  const { calls, deps } = stubDeps()
  const router = createMainRequestRouter(deps)

  for (const command of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
    await router.handle(command, { shareId: 's1', mountPath: '/tmp/x' })
    t.ok(warnings.some((l) => l.includes(command)), `'${command}' is refused out loud`)
  }

  t.alike(calls, [], 'and nothing was done')
})

test('a known command still reaches its handler', async (t) => {
  const { calls, deps } = stubDeps()
  const router = createMainRequestRouter(deps)

  await router.handle(MAIN_REQUEST.OWNED_FOLDER_START_WATCHER, { shareId: 's1', mountPath: '/tmp/x' })
  await router.handle(MAIN_REQUEST.OWNED_FOLDER_STOP_WATCHER, { shareId: 's1' })

  t.alike(calls.map((c) => c[0]), ['startWatcher', 'stopWatcher'])
})

test('every main-request command the worker emits is one main handles', (t) => {
  const router = createMainRequestRouter(stubDeps().deps)
  const sites = emitSites()
  t.ok(sites.length >= 11, `found the emit sites (${sites.length})`)

  for (const site of sites) {
    t.absent(site.opaque, `${path.relative(SRC, site.file)}: the command is readable at the emit site`)
    const name = site.constant ? MAIN_REQUEST[site.constant] : site.literal
    t.ok(name, `${path.relative(SRC, site.file)}: ${site.constant ?? site.literal} names a command`)
    t.ok(router.commands.includes(name), `${path.relative(SRC, site.file)}: main routes '${name}'`)
  }
})

test('every command main handles is emitted somewhere', (t) => {
  const router = createMainRequestRouter(stubDeps().deps)
  const emitted = new Set(emitSites().map((s) => (s.constant ? MAIN_REQUEST[s.constant] : s.literal)))
  for (const command of router.commands) t.ok(emitted.has(command), `'${command}' is emitted by the worker`)
})

test('the contract declares exactly the commands main routes', (t) => {
  const router = createMainRequestRouter(stubDeps().deps)
  t.alike([...router.commands].sort(), [...MAIN_REQUEST_NAMES].sort())
})

test('no emit site writes a bare main-request command literal', (t) => {
  for (const site of emitSites()) {
    t.is(site.literal, null, `${path.relative(SRC, site.file)} names the command through MAIN_REQUEST`)
  }
})

// Main is CommonJS and builds its dispatch table at module-evaluation time, so the vocabulary has to
// be require()-able. That works because the contract has no top-level await and no imports — a
// property contract-declarations.test.js already enforces. Pinned here so it fails in CI rather
// than as ERR_REQUIRE_ESM at a user's first launch.
test('the contract is reachable from a CommonJS main', (t) => {
  const require = createRequire(import.meta.url)
  const mod = require('../../src/shared/contract/main-requests.js')
  t.is(mod.MAIN_REQUEST_FRAME, 'main-request')
  t.alike([...mod.MAIN_REQUEST_NAMES].sort(), [...MAIN_REQUEST_NAMES].sort())
})

// A second copy of the watcher bridge lived directly beneath the router: two ipcMain channels that
// re-implemented the start/stop arms with their own inlined frame write, their own wording of the
// same two warnings, and a hard-coded worker specifier. Nothing in src/renderer called them, so the
// only thing they added was a renderer-reachable way to arm a chokidar watcher on any path — past
// the bus, past the vocabulary, and past every guard in this file.
test('no ipcMain channel duplicates a main-request command', (t) => {
  const file = path.join(SRC, 'main', 'main.js')
  const { ast, visitorKeys } = parseSource(readFileSync(file, 'utf8'), file)

  const channels = []
  forEachNode(ast, visitorKeys, (node) => {
    if (node.type !== 'CallExpression') return
    if (calleeName(node.callee) !== 'handle') return
    const name = staticString(node.arguments[0])
    if (name && MAIN_REQUEST_NAMES.includes(name)) channels.push(name)
  })

  t.alike(channels, [], 'the worker bus is the only way to reach these')
})
