// Imports nothing, so both runtimes load it: console is global under Node and under Bare.
//
// Three shapes because three are genuinely in use, and collapsing them would lose something:
//   capture()  collects every call and restores on teardown.
//   tagged()   collects only lines whose first argument is a tag and PASSES THE REST THROUGH, so a
//              real warning from elsewhere still reaches the terminal during the test.
//   around()   scopes the swap to one synchronous call, for a test with no brittle `t` to hang a
//              teardown on.
const LEVELS = ['log', 'warn', 'error']

function swap(levels, make) {
  const real = {}
  for (const level of levels) {
    real[level] = console[level]
    console[level] = make(level, real[level])
  }
  return () => Object.assign(console, real)
}

export function capture(t, levels = ['warn']) {
  const lines = Object.fromEntries(levels.map((l) => [l, []]))
  const restore = swap(levels, (level) => (...args) => lines[level].push(args.join(' ')))
  t.teardown(restore)
  return lines
}

// The array is live: callers hold it across the calls they are provoking, so a snapshot taken here
// would always be empty.
export function tagged(t, tag, { levels = ['log', 'warn'], join = false } = {}) {
  const lines = []
  const restore = swap(levels, (level, real) => (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith(tag)) {
      const rest = args.slice(1)
      lines.push(join ? rest.join(' ') : rest)
      return
    }
    real(...args)
  })
  t.teardown(restore)
  return lines
}

export function around(fn, levels = LEVELS) {
  const out = Object.fromEntries(levels.map((l) => [l, []]))
  const restore = swap(levels, (level) => (...args) => out[level].push(args.join(' ')))
  try { fn() } finally { restore() }
  return out
}
