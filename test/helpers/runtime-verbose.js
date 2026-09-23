// `verbose` is one module-level flag shared by every suite in a run, and it changes only what the
// logger prints — so a suite that leaves it on does not fail, it makes a LATER suite's "silent at
// the default level" assertion see a stray line from a file it never imported. Flipping it through
// here is what pairs every flip with the restore that undoes it.
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'

// Only the FIRST call in a test saves and registers the restore, so a test that flips the flag
// mid-body still ends on the config it started with however the teardowns are ordered.
const entered = new WeakMap()

// Merged over the live config, never replacing it: buildConfig rebuilds from `next` alone, so a
// bare `{ verbose }` would also drop every other override the caller set.
export function setVerbose(t, verbose) {
  if (!entered.has(t)) {
    const prev = getRuntimeConfig()
    entered.set(t, prev)
    t.teardown(() => setRuntimeConfig(prev))
  }
  setRuntimeConfig({ ...getRuntimeConfig(), verbose })
}
