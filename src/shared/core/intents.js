// Durable intent log: a multi-step flow writes what it is about to do as its FIRST durable act and
// deletes the record as its LAST, so a crash anywhere between them leaves something the next boot
// can finish. The rule "durable fact first" was already stated independently at four sites, each
// after its own bug; this is that rule as one mechanism instead of four.
//
// No domain knowledge and no bare-* imports: the bee arrives as a dependency, so this unit-tests
// under Node and the reconcilers live with the flows they complete.
export const INTENT_PREFIX = 'intent/'

let seq = 0

export function intentId(kind) {
  return `${INTENT_PREFIX}${kind}/${Date.now()}-${seq++}`
}

export function createIntentLog({ bee, log } = {}) {
  const reconcilers = new Map()

  return {
    register(kind, complete) {
      if (reconcilers.has(kind)) throw new Error(`duplicate intent reconciler: ${kind}`)
      reconcilers.set(kind, complete)
    },

    // Refusing an unregistered kind here turns a typo at the call site into a boot-time failure
    // rather than an orphan record nothing will ever complete.
    async begin(kind, args) {
      if (!reconcilers.has(kind)) throw new Error(`no reconciler registered for intent: ${kind}`)
      const id = intentId(kind)
      await bee().put(id, { kind, args, at: Date.now() })
      return id
    },

    // Best-effort: a flow that cannot record its intent still runs, it just loses the recovery net
    // and behaves exactly as it did before intents existed. Refusing the user's delete because a
    // bookkeeping write failed would be a worse outcome than the crash window it guards against —
    // the same call the leave marker already makes (space.js's markSpaceLeavingDurable).
    async beginOrNull(kind, args) {
      try {
        return await this.begin(kind, args)
      } catch (err) {
        log?.warn('could not record the intent — the flow runs unprotected:', kind, '-', err.message)
        return null
      }
    },

    // Tolerates null so a caller that failed to record does not have to branch, and never throws:
    // the work is already done, and a surviving record is only ever re-run idempotently.
    async complete(id) {
      if (!id) return
      try {
        await bee().del(id)
      } catch (err) {
        log?.warn('could not clear a completed intent — it will re-run harmlessly next boot:', '-', err.message)
      }
    },

    async list() {
      const out = []
      for await (const node of bee().createReadStream({ gte: INTENT_PREFIX, lt: INTENT_PREFIX + '\xff' })) {
        out.push({ id: node.key, ...node.value })
      }
      return out
    },

    // Per-intent isolation: one wedged kind must not strand the rest. A reconciler that throws
    // KEEPS its record for the next boot; an intent whose kind is unknown is left untouched, so an
    // older build can never eat a newer one's record.
    async recover() {
      for (const intent of await this.list()) {
        const complete = reconcilers.get(intent.kind)
        if (!complete) {
          log?.warn('intent has no reconciler, leaving it for a build that has one:', intent.kind)
          continue
        }
        try {
          await complete(intent.args)
          await bee().del(intent.id)
          log?.info('completed interrupted intent:', intent.kind)
        } catch (err) {
          log?.warn('intent recovery failed, retrying next boot:', intent.kind, '-', err.message)
        }
      }
    },

    kinds: () => [...reconcilers.keys()],
  }
}
