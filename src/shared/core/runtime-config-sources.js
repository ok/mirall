// The three sources of runtime config, in precedence order: the host's bootstrap frame (host facts,
// secrets and test levers) over the worker's own settings over the shipped feature flags. Every key
// the bootstrap carries wins, which is how the flow harness sets a flag or a cap for one run;
// bootstrap-allowlist.test.js is what keeps a preference from riding there.
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

function definedEntries(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))
}

export function assembleRuntimeConfig({ bootstrap, settings, flags }) {
  return { ...flagsToRuntimeConfig(flags), ...settingsToRuntimeConfig(settings), ...definedEntries(bootstrap) }
}
