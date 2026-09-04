// An effect that writes React state after an await is a race by default: React does not cancel the
// continuation, so a response issued for the PREVIOUS deps can land after a newer one and win. The
// renderer already has the correct answer — store/query-store.js carries a per-entry `seq` and an
// AbortController, and useQuery/useMainQuery inherit both — so a hook that reaches past it owes the
// same guarantee by hand, or an entry in the exemption table with a reason.
//
// This is a RULE and not a `no-restricted-syntax` selector (the shape the rest of eslint.config.mjs
// uses) because the property is not a syntactic shape. It needs three things esquery cannot do:
// reachability from an async boundary to a setter, scope resolution of `setX` to a useState
// binding, and one hop of call-graph following into a useCallback. The predecessor guard was a
// regex for `let cancelled = false`, which measured a spelling — it saw four of the eleven
// hand-rolled guards in the tree and, more to the point, could never see a site with no guard at
// all, which is the only thing that is actually forbidden.

const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect'])
const CONTINUATIONS = new Set(['then', 'catch', 'finally'])
// A function handed to one of these is a fresh event context, not the continuation of the await
// above it, so it does not inherit post-async position.
const DEFERRED = new Set(['subscribe', 'addEventListener', 'on', 'once', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask'])
// Reads that carry supersession themselves.
const GUARDED_READS = new Set(['useQuery', 'useMainQuery', 'usePrefs', 'fetchQuery'])
const FUNCTION_TYPES = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'])

function isFunction (node) {
  return !!node && FUNCTION_TYPES.has(node.type)
}

function calleeName (callee) {
  if (!callee) return null
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name
  }
  return null
}

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Require a supersession guard on any effect that writes state after an async boundary' },
    schema: [{
      type: 'object',
      properties: { allow: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    }],
  },

  create (context) {
    // eslint's job here is to keep CI and the editor quiet about the effects that are already
    // reasoned about; the ratchet that decides WHICH those are lives in
    // test/unit/renderer-stale-guard-ratchet.test.js, which drives this rule with no allowances at
    // all and compares the full report set against the table. A file-level allowance cannot hide a
    // new violation from that test.
    const allow = (context.options[0] && context.options[0].allow) || []
    const filename = context.filename.split('\\').join('/')
    if (allow.some((suffix) => filename.endsWith(suffix))) return {}

    const sourceCode = context.sourceCode
    const keys = sourceCode.visitorKeys

    function children (node) {
      const out = []
      for (const key of keys[node.type] || []) {
        const child = node[key]
        if (Array.isArray(child)) { for (const c of child) if (c && typeof c.type === 'string') out.push(c) } else if (child && typeof child.type === 'string') out.push(child)
      }
      return out
    }

    function walk (node, visit) {
      visit(node)
      for (const child of children(node)) walk(child, visit)
    }

    function lookup (name, at) {
      for (let scope = sourceCode.getScope(at); scope; scope = scope.upper) {
        const variable = scope.set.get(name)
        if (variable) return variable
      }
      return null
    }

    // `setWrapperRef` in components/primitives/Modal.tsx is an ordinary function, not a setter. The
    // name is no evidence of anything; the binding is.
    function isStateSetter (node) {
      if (!node || node.type !== 'Identifier') return false
      const variable = lookup(node.name, node)
      const def = variable && variable.defs[0]
      if (!def || def.type !== 'Variable') return false
      const declarator = def.node
      if (!declarator.id || declarator.id.type !== 'ArrayPattern') return false
      if (declarator.id.elements[1] !== def.name) return false
      const hook = declarator.init && declarator.init.type === 'CallExpression' && calleeName(declarator.init.callee)
      return hook === 'useState' || hook === 'useReducer'
    }

    // One hop, deliberately: the three out-of-order defects this rule was written for all put the
    // async work in a `const refresh = useCallback(async …)` that the effect merely invokes, so a
    // rule that only walks the effect body misses exactly the highest-risk class. Two hops is the
    // known residual.
    function resolveCalledFunction (callee) {
      if (!callee || callee.type !== 'Identifier') return null
      const variable = lookup(callee.name, callee)
      const def = variable && variable.defs[0]
      if (!def) return null
      if (def.type === 'FunctionName') return def.node
      if (def.type !== 'Variable') return null
      const init = def.node.init
      if (isFunction(init)) return init
      if (init && init.type === 'CallExpression' && calleeName(init.callee) === 'useCallback' && isFunction(init.arguments[0])) {
        return init.arguments[0]
      }
      return null
    }

    function ownAwaitStart (fn) {
      let first = Infinity
      const visit = (node) => {
        if (node !== fn && isFunction(node)) return
        if (node.type === 'AwaitExpression' || node.type === 'ForOfStatement' && node.await) {
          first = Math.min(first, node.range[0])
        }
        for (const child of children(node)) visit(child)
      }
      visit(fn)
      return first
    }

    // Three acceptors, all name-blind: a flag flipped in the cleanup closure, a ref compared against
    // a captured generation, or an abort signal. Renaming `cancelled` to `alive` — which is what
    // four hooks in this tree already did — changes nothing here.
    function hasGuardEvidence (region, effectFn) {
      const cleanups = []
      walk(effectFn, (node) => {
        if (node.type !== 'ReturnStatement' || !node.argument) return
        if (isFunction(node.argument)) cleanups.push(node.argument)
        else {
          const resolved = resolveCalledFunction(node.argument)
          if (resolved) cleanups.push(resolved)
        }
      })

      const booleanFlags = new Set()
      const clearedInCleanup = new Set()
      const readAsCondition = new Set()
      let generation = false
      let abort = false
      let guardedRead = false

      const noteConditionReads = (node) => {
        walk(node, (n) => { if (n.type === 'Identifier') readAsCondition.add(n.name) })
      }

      for (const fn of region) {
        walk(fn, (node) => {
          if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init &&
              node.init.type === 'Literal' && typeof node.init.value === 'boolean') {
            booleanFlags.add(node.id.name)
          }
          if (node.type === 'IfStatement') noteConditionReads(node.test)
          if (node.type === 'ConditionalExpression') noteConditionReads(node.test)
          if (node.type === 'LogicalExpression') noteConditionReads(node)
          if (node.type === 'UnaryExpression' && node.operator === '!') noteConditionReads(node.argument)
          if ((node.type === 'BinaryExpression') && (node.operator === '===' || node.operator === '!==')) {
            const touchesCurrent = [node.left, node.right].some((side) =>
              side.type === 'MemberExpression' && !side.computed && side.property.type === 'Identifier' && side.property.name === 'current')
            if (touchesCurrent) generation = true
          }
          if (node.type === 'NewExpression' && calleeName(node.callee) === 'AbortController') abort = true
          if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && node.property.name === 'signal') abort = true
          if (node.type === 'CallExpression') {
            const name = calleeName(node.callee)
            if (name === 'abort') abort = true
            if (GUARDED_READS.has(name)) guardedRead = true
          }
        })
      }

      for (const cleanup of cleanups) {
        walk(cleanup, (node) => {
          if (node.type !== 'AssignmentExpression' || node.operator !== '=') return
          if (node.left.type === 'Identifier' && node.right.type === 'Literal' && typeof node.right.value === 'boolean') {
            clearedInCleanup.add(node.left.name)
          }
        })
      }

      const flag = [...booleanFlags].some((name) => clearedInCleanup.has(name) && readAsCondition.has(name))
      return flag || generation || abort || guardedRead
    }

    function postAsyncSetters (region) {
      const setters = new Set()

      const visit = (node, post, firstAwait) => {
        const here = post || node.range[0] > firstAwait

        if (node.type === 'CallExpression') {
          if (here && isStateSetter(node.callee)) setters.add(node.callee.name)
          if (CONTINUATIONS.has(calleeName(node.callee))) {
            for (const arg of node.arguments) if (isStateSetter(arg)) setters.add(arg.name)
          }
        }

        for (const child of children(node)) {
          if (!isFunction(child)) { visit(child, here, firstAwait); continue }
          const parentCallee = node.type === 'CallExpression' ? calleeName(node.callee) : null
          const childPost = CONTINUATIONS.has(parentCallee) ? true
            : DEFERRED.has(parentCallee) ? false
              : here
          visit(child, childPost, ownAwaitStart(child))
        }
      }

      for (const fn of region) visit(fn, false, ownAwaitStart(fn))
      return [...setters]
    }

    // A function registered as an event handler is not part of the effect's own read path — what it
    // does when the user clicks is a different question from what the effect does when its deps
    // change. Following into one would report SpaceView's add-folder command as an effect race.
    function deferredHandlers (root) {
      const handlers = new Set()
      walk(root, (node) => {
        if (node.type !== 'CallExpression' || !DEFERRED.has(calleeName(node.callee))) return
        for (const arg of node.arguments) {
          if (isFunction(arg)) handlers.add(arg)
          else {
            const resolved = resolveCalledFunction(arg)
            if (resolved) handlers.add(resolved)
          }
        }
      })
      return handlers
    }

    return {
      CallExpression (node) {
        if (!EFFECT_HOOKS.has(calleeName(node.callee))) return
        const effectFn = node.arguments[0]
        if (!isFunction(effectFn)) return

        const handlers = deferredHandlers(effectFn)
        const region = [effectFn]
        const collect = (n) => {
          if (n !== effectFn && handlers.has(n)) return
          if (n.type === 'CallExpression') {
            const target = resolveCalledFunction(n.callee)
            if (target && !region.includes(target)) region.push(target)
          }
          for (const child of children(n)) collect(child)
        }
        collect(effectFn)

        const setters = postAsyncSetters(region)
        if (!setters.length) return
        if (hasGuardEvidence(region, effectFn)) return

        context.report({
          node: node.callee,
          message: `This effect writes ${setters.sort().join(', ')} after an async boundary with nothing to tell a superseded response from a current one. Read through useQuery/useMainQuery, or carry a generation ref or a cleanup flag.`,
        })
      },
    }
  },
}
