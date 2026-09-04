// Finds the event names a source file actually emits or subscribes to, by parsing it rather than by
// matching text. The guard this replaces used /\.emit\('(event:[a-z-]+)'/ — it required a leading
// dot and single quotes, so `emit('event:reconcile', …)` in src/shared/state/hints.js (where `emit`
// is a bare parameter) was invisible, and that one name is the fan-in point for the entire
// level-triggered reconcile channel.
import { parseSource, forEachNode, staticString, calleeName } from './ast-scan.js'

function namesCalledOn (source, filePath, fn) {
  const { ast, visitorKeys } = parseSource(source, filePath)
  const found = new Set()
  forEachNode(ast, visitorKeys, (node) => {
    if (node.type !== 'CallExpression') return
    if (calleeName(node.callee) !== fn) return
    const name = staticString(node.arguments[0])
    if (name && name.startsWith('event:')) found.add(name)
  })
  return found
}

// Total over emit syntax: `emit(…)`, `x.emit(…)`, `x?.emit(…)`, `x['emit'](…)`, single or double
// quotes, backticks.
export function emitSites (source, filePath) {
  return namesCalledOn(source, filePath, 'emit')
}

export function subscribeSites (source, filePath) {
  return namesCalledOn(source, filePath, 'subscribe')
}
