// The order of a space teardown, shared by the two callers that run it: the live space:leave
// handler and boot's interrupted-leave pass. They differ in what each step DOES — the live path
// also stops in-memory machinery (watchers, publish lanes, mirror loops) that a fresh boot has
// none of — so each supplies its own steps and this module owns only the sequence and the policy.
// Owning the sequence is the point: the two used to encode it independently and drift.
//
// Step 1 is the hard gate for the boot caller: co-member convergence depends on the durable
// departure, so a throw there must keep the intent for the next boot rather than continue to the
// forget. Steps 2-4 are best-effort, so one bad record cannot strand the others or the forget.
export const LEAVE_PHASES = ['clearOwnMembership', 'ownedMounts', 'shares', 'foreignMounts', 'forget']

export async function runLeaveTeardown(spaceId, steps, { log, onPhase = () => {} } = {}) {
  onPhase('clearOwnMembership')
  await steps.clearMembership()

  for (const phase of ['ownedMounts', 'shares', 'foreignMounts']) {
    onPhase(phase)
    try {
      await steps[phase]()
    } catch (err) {
      log?.warn(`leave: ${phase} step failed:`, spaceId, '-', err.message)
    }
  }

  onPhase('forget')
  await steps.forget()
}
