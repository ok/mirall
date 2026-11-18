// The four sources of runtime config, in precedence order: the host's bootstrap frame (host facts,
// secrets and test levers) over the test run file over the worker's own settings over the shipped
// feature flags. Every key the bootstrap carries wins, which is how the flow harness sets a flag or
// a cap for one run; bootstrap-allowlist.test.js is what keeps a preference from riding there.
import { settingsToRuntimeConfig } from './settings-rules.js'

export function flagsToRuntimeConfig(flags) {
  return {
    // Staged: until feature-flags.json turns it on, a membership:cancel or membership:deny that
    // names no sender (a peer on an older release) is still honoured.
    membershipControlBindingEnforced: flags.membershipControlBinding === true,
    // Staged: off until feature-flags.json turns it on, because a peer on a release that cannot
    // read a topic reference is cut off once it is on.
    topicRefsEnforced: flags.topicRefs === true,
  }
}

const RUN_NAME = /^[A-Za-z0-9_-]{1,32}$/

// A lever value the test run file may carry: a whole number in its range, else absent.
const wholeBetween = (min, max) => (v) => (Number.isInteger(v) && v >= min && v <= max ? v : undefined)
const MIB = 1024 * 1024

// The sizing values a test run may replace, and the path check. Each has the range a mistyped file
// cannot leave: an in-flight cap the scheduler can hold, a stash and socket buffers a worker can
// afford, a path check no longer than one large file.
const LEVERS = Object.freeze({
  inflightCap: wholeBetween(1, 256),
  stashBytes: wholeBetween(0, 1024 * MIB),
  recvBufferBytes: wholeBetween(64 * 1024, 64 * MIB),
  sendBufferBytes: wholeBetween(64 * 1024, 64 * MIB),
  pathCheck: (v) => (v === true ? true : undefined),
  pathCheckBytes: wholeBetween(MIB, 64 * 1024 * MIB),
})

function leversOf(testRun) {
  const levers = definedEntries(Object.fromEntries(Object.entries(LEVERS).map(([name, take]) => [name, take(testRun[name])])))
  return Object.keys(levers).length > 0 ? Object.freeze(levers) : undefined
}

// The test run file names a run, turns the transfer trace on and sets the transfer levers. A file
// that is absent, not an object, or carries anything else contributes nothing, so the app runs as
// shipped.
export function testRunToRuntimeConfig(testRun) {
  if (typeof testRun !== 'object' || testRun === null || Array.isArray(testRun)) return {}
  return definedEntries({
    testRunName: typeof testRun.run === 'string' && RUN_NAME.test(testRun.run) ? testRun.run : undefined,
    transferTrace: testRun.trace === true ? true : undefined,
    transferLevers: leversOf(testRun),
  })
}

function definedEntries(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))
}

export function assembleRuntimeConfig({ bootstrap, settings, flags, testRun = null }) {
  return {
    ...flagsToRuntimeConfig(flags),
    ...settingsToRuntimeConfig(settings),
    ...testRunToRuntimeConfig(testRun),
    ...definedEntries(bootstrap),
  }
}
