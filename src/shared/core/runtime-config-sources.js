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

// The test run file names a run and turns the transfer trace on. A file that is absent, not an
// object, or carries anything else contributes nothing, so the app runs as shipped.
export function testRunToRuntimeConfig(testRun) {
  if (typeof testRun !== 'object' || testRun === null || Array.isArray(testRun)) return {}
  return definedEntries({
    testRunName: typeof testRun.run === 'string' && RUN_NAME.test(testRun.run) ? testRun.run : undefined,
    transferTrace: testRun.trace === true ? true : undefined,
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
