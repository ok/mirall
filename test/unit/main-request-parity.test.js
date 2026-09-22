import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import path from 'path'
import { createMainRequestRouter } from '../../src/main/main-requests.js'
import { MAIN_REQUEST, MAIN_REQUEST_NAMES, MAIN_REQUEST_FRAME } from '../../src/shared/contract/main-requests.js'
import { parseSource, forEachNode, staticString, calleeName } from '../helpers/ast-scan.js'
import { capture } from '../helpers/capture-console.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', '..', 'src')

function walk(dir, out = []) {
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
function commandOf(frame) {
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

function emitSites() {
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

function stubDeps({ debug = false, quitting = false } = {}) {
  const calls = []
  return {
    calls,
    deps: {
      isDebug: () => debug,
      isQuitting: () => quitting,
      folderWatchers: {
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

const muteWarn = (t) => capture(t).warn

// REGRESSION (FIX-H3-1: handleMainRequest was five `if (command === …) return` blocks with nothing
// after them, so an unrecognised command resolved undefined and the caller's .catch never fired.
// A half-finished rename would arm no watcher on any owned folder, on every peer, silently.)
test('REGRESSION (FIX-H3-1): an unknown main-request command is refused loudly, not silently ignored', async (t) => {
  const warnings = muteWarn(t)
  const { calls, deps } = stubDeps()
  const router = createMainRequestRouter(deps)

  await router.dispatch('owned-folder:watch', { shareId: 's1', mountPath: '/tmp/x' })

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
    await router.dispatch(command, { shareId: 's1', mountPath: '/tmp/x' })
    t.ok(warnings.some((l) => l.includes(command)), `'${command}' is refused out loud`)
  }

  t.alike(calls, [], 'and nothing was done')
})

test('a known command still reaches its handler', async (t) => {
  const { calls, deps } = stubDeps()
  const router = createMainRequestRouter(deps)

  await router.dispatch(MAIN_REQUEST.OWNED_FOLDER_START_WATCHER, { shareId: 's1', mountPath: '/tmp/x' })
  await router.dispatch(MAIN_REQUEST.OWNED_FOLDER_STOP_WATCHER, { shareId: 's1' })

  t.alike(calls.map((c) => c[0]), ['startWatcher', 'stopWatcher'])
})

// One registry serves both kinds, so the two keys must differ for the same share, and each kind's
// events must carry its own frame — the frame builder is the router's, not the registry's.
test('a mirror watcher is keyed by its mount pair and its events name both ids', async (t) => {
  const { calls, deps } = stubDeps()
  const router = createMainRequestRouter(deps)

  await router.dispatch(MAIN_REQUEST.OWNED_FOLDER_START_WATCHER, { shareId: 's1', mountPath: '/tmp/x' }, 'w')
  await router.dispatch(MAIN_REQUEST.FOREIGN_FOLDER_START_WATCHER, { spaceId: 'sp', shareId: 's1', mountPath: '/tmp/y' }, 'w')
  const [owned, mirror] = calls.filter((c) => c[0] === 'startWatcher')
  t.is(owned[1], 's1')
  t.is(mirror[1], 'sp:s1', 'a second key for the same share')
  t.is(mirror[3], null, 'a mirror takes the default ignore list')

  owned[4]({ action: 'change', relPath: 'f.txt', absPath: '/tmp/x/f.txt' })
  mirror[4]({ action: 'change', relPath: 'f.txt', absPath: '/tmp/y/f.txt' })
  const frames = calls.filter((c) => c[0] === 'sendToWorker').map((c) => c[1])
  t.alike(frames, [
    { type: 'event:owned-folder-fs-event', shareId: 's1', action: 'change', relPath: 'f.txt', absPath: '/tmp/x/f.txt' },
    { type: 'event:foreign-folder-fs-event', spaceId: 'sp', shareId: 's1', action: 'change', relPath: 'f.txt', absPath: '/tmp/y/f.txt' },
  ])

  await router.dispatch(MAIN_REQUEST.FOREIGN_FOLDER_STOP_WATCHER, { spaceId: 'sp', shareId: 's1' })
  t.alike(calls.at(-1), ['stopWatcher', 'sp:s1'])
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

// `mainRequests` is a const, and the worker's data handler closes over it. It used to be declared
// ~300 lines below getWorker, which works only while every spawn arrives from an ipcMain callback:
// any synchronously-dispatched spawn added above the declaration turns the first worker frame into
// a TDZ ReferenceError thrown inside a stream listener, where nothing catches it.
test('the router is built before the worker handler that closes over it', (t) => {
  const src = readFileSync(path.join(SRC, 'main', 'worker-host.js'), 'utf8')
  const router = src.indexOf('const mainRequests = createMainRequestRouter')
  const reader = src.indexOf('function getWorker')
  t.ok(router !== -1 && reader !== -1, 'found both')
  t.ok(router < reader, 'the router is initialised above getWorker')
})

// REGRESSION (FIX-OBS-2: a main request that threw was logged only behind `debug`, so a watcher
// that failed to arm left no line in the log ring and an owned folder stopped re-publishing with
// nothing in the diagnostics bundle to say why.)
test('REGRESSION (FIX-OBS-2): a failed main request is warned unconditionally', async (t) => {
  const warnings = muteWarn(t)
  const { deps } = stubDeps()
  deps.folderWatchers.startWatcher = async () => {
    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
  }
  const router = createMainRequestRouter(deps)
  const command = MAIN_REQUEST.OWNED_FOLDER_START_WATCHER

  await router.dispatch(command, { shareId: 's1', mountPath: '/tmp/x' })

  const line = warnings.find((l) => l.includes('[main-request] failed'))
  t.ok(line, 'the failure reached console.warn, which feeds the log ring')
  t.ok(line?.includes(command), 'names the command')
  t.ok(line?.includes('permission denied'), 'carries the message')
})

const failedLines = (warnings) => warnings.filter((l) => l.includes('[main-request] failed'))
const failure = (code) => Object.assign(new Error('nope'), { code })

function failingRouter(flags, fail, now) {
  const { deps } = stubDeps(flags)
  deps.setDownloadRoots = () => { throw fail() }
  return createMainRequestRouter({ ...deps, ...(now && { now }) })
}

test('a repeated failure with the same code is warned once a window; a new code warns again', async (t) => {
  const warnings = muteWarn(t)
  let clock = 0
  let code = 'EACCES'
  const router = failingRouter({}, () => failure(code), () => clock)

  for (let i = 0; i < 50; i++) await router.dispatch(MAIN_REQUEST.DOWNLOADS_ROOTS, {})
  t.is(failedLines(warnings).length, 1, 'fifty identical failures, one line')

  code = 'EMFILE'
  await router.dispatch(MAIN_REQUEST.DOWNLOADS_ROOTS, {})
  t.is(failedLines(warnings).length, 2, 'a different code is a different failure')

  code = 'EACCES'
  clock += 600000
  await router.dispatch(MAIN_REQUEST.DOWNLOADS_ROOTS, {})
  t.is(failedLines(warnings).length, 3, 'the same failure is said again once the window has passed')
})

test('distinct failure codes are capped, and the cap is reported once a window', async (t) => {
  const warnings = muteWarn(t)
  let i = 0
  const router = failingRouter({}, () => failure('E' + i++), () => 0)
  for (let n = 0; n < 40; n++) await router.dispatch(MAIN_REQUEST.DOWNLOADS_ROOTS, {})
  t.is(failedLines(warnings).length, 16, 'bounded')
  t.is(warnings.filter((l) => l.includes('too many distinct failures')).length, 1, 'the cap says so once')
})

test('dispatch never rejects: a handler that throws, rejects, or throws a non-Error', async (t) => {
  const warnings = muteWarn(t)
  const { deps } = stubDeps()
  deps.setDownloadRoots = () => { throw failure('ESYNC') }
  deps.folderWatchers.startWatcher = async () => { throw failure('EASYNC') }
  deps.looseFileWatchers.removeLooseWatch = () => { throw undefined }
  deps.looseFileWatchers.addLooseWatch = () => { throw 'boom' }
  const router = createMainRequestRouter(deps)

  await t.execution(router.dispatch(MAIN_REQUEST.DOWNLOADS_ROOTS, {}), 'sync throw')
  await t.execution(router.dispatch(MAIN_REQUEST.OWNED_FOLDER_START_WATCHER, { shareId: 's1', mountPath: '/tmp/x' }), 'async rejection')
  await t.execution(router.dispatch(MAIN_REQUEST.LOOSE_FILE_UNWATCH, {}), 'a throw with no error object')
  await t.execution(router.dispatch(MAIN_REQUEST.LOOSE_FILE_WATCH, {}), 'a thrown string')
  await t.execution(router.dispatch('no-such-command', {}), 'unknown command')

  const lines = failedLines(warnings)
  t.ok(lines.some((l) => l.includes(MAIN_REQUEST.LOOSE_FILE_UNWATCH + ' - undefined')), 'a thrown undefined is named as such')
  t.ok(lines.some((l) => l.includes(MAIN_REQUEST.LOOSE_FILE_WATCH + ' - boom')), 'a thrown string is its own message')
})

test('a router built without its debug and quit gates is a wiring error, thrown at build time', (t) => {
  const { deps } = stubDeps()
  t.exception.all(() => createMainRequestRouter({ ...deps, isDebug: undefined }), /isDebug and isQuitting/)
  t.exception.all(() => createMainRequestRouter({ ...deps, isQuitting: undefined }), /isDebug and isQuitting/)
})

// A command comes off JSON.parse, so it can be an object; `{ toString: 1 }` throws on a property
// lookup, which is where a table keyed by the raw value would reject.
test('a command that is not a string is refused as unknown, not thrown', async (t) => {
  const warnings = muteWarn(t)
  const router = createMainRequestRouter(stubDeps().deps)
  await t.execution(router.dispatch({ toString: 1 }, {}))
  t.ok(warnings.some((l) => l.includes('unknown command') && l.includes('object')), 'named by its type')
})

test('in debug every failure is logged, repeats included, and none is rate-limited', async (t) => {
  const lines = capture(t, ['warn', 'error'])
  const router = failingRouter({ debug: true }, () => failure('EACCES'))
  for (let i = 0; i < 3; i++) await router.dispatch(MAIN_REQUEST.DOWNLOADS_ROOTS, {})
  for (let i = 0; i < 3; i++) await router.dispatch('no-such-command', {})
  t.is(lines.error.filter((l) => l.includes('[main-request] failed') && l.includes('nope')).length, 3)
  t.is(lines.error.filter((l) => l.includes('unknown command') && l.includes('no-such-command')).length, 3)
  t.is(lines.warn.length, 0, 'the rate-limited warnings are not used')
})

test('during a quit a failure and an unknown command are silent', async (t) => {
  const lines = capture(t, ['warn', 'error'])
  const router = failingRouter({ quitting: true }, () => failure('EACCES'))
  await router.dispatch(MAIN_REQUEST.DOWNLOADS_ROOTS, {})
  await router.dispatch('no-such-command', {})
  t.alike(lines, { warn: [], error: [] })
})

test('debug outranks a quit: a failure racing teardown is still logged in debug', async (t) => {
  const lines = capture(t, ['warn', 'error'])
  const router = failingRouter({ debug: true, quitting: true }, () => failure('EACCES'))
  await router.dispatch(MAIN_REQUEST.DOWNLOADS_ROOTS, {})
  t.is(lines.error.length, 1)
  t.is(lines.warn.length, 0)
})

const WORKER_HOST = path.join(SRC, 'main', 'worker-host.js')

const isDispatchCall = (node) => node.type === 'CallExpression'
  && node.callee.type === 'MemberExpression'
  && node.callee.object.type === 'Identifier' && node.callee.object.name === 'mainRequests'
  && calleeName(node.callee) === 'dispatch'

// Every mainRequests.dispatch call, and whether it stands alone as a statement: anything chained on
// it (`.catch`, `.then`) makes the call a member's object instead.
function dispatchCalls(source, file) {
  const { ast, visitorKeys } = parseSource(source, file)
  const calls = []
  const bare = new Set()
  forEachNode(ast, visitorKeys, (node) => {
    if (node.type === 'ExpressionStatement' && isDispatchCall(node.expression)) bare.add(node.expression)
    if (isDispatchCall(node)) calls.push(node)
  })
  return calls.map((call) => bare.has(call))
}

function routerOptionKeys(source, file) {
  const { ast, visitorKeys } = parseSource(source, file)
  const keys = []
  forEachNode(ast, visitorKeys, (node) => {
    if (node.type !== 'CallExpression' || calleeName(node.callee) !== 'createMainRequestRouter') return
    const opts = node.arguments[0]
    if (opts?.type !== 'ObjectExpression') return
    for (const prop of opts.properties) {
      if (prop.type === 'Property') keys.push(prop.computed ? staticString(prop.key) : (prop.key.name ?? staticString(prop.key)))
    }
  })
  return keys
}

test('the worker frame handler hands every request to the router bare', (t) => {
  const calls = dispatchCalls(readFileSync(WORKER_HOST, 'utf8'), WORKER_HOST)
  t.ok(calls.length >= 1, 'found the frame dispatch')
  t.ok(calls.every(Boolean), 'nothing is chained on it')
})

test('the bare-dispatch check refuses a call with a handler chained on the next line', (t) => {
  const chained = 'mainRequests.dispatch(msg.command, msg.args || {}, worker)\r\n  .catch(() => {})\n'
  t.alike(dispatchCalls(chained, 'fixture.js'), [false])
  t.alike(dispatchCalls('mainRequests.dispatch(a, b, c)\n', 'fixture.js'), [true])
})

test('worker-host builds the router with its debug and quit gates', (t) => {
  const keys = routerOptionKeys(readFileSync(WORKER_HOST, 'utf8'), WORKER_HOST)
  t.ok(keys.includes('isDebug'), 'isDebug')
  t.ok(keys.includes('isQuitting'), 'isQuitting')
  t.alike(routerOptionKeys('createMainRequestRouter({ isDebug: () => d, isQuitting })', 'fixture.js'), ['isDebug', 'isQuitting'], 'any spelling of the property counts')
})
