// File-argument resolution shared by the flow and bare runners. `dir/*.suffix` is the only pattern
// the suites use; anything else is taken literally. A pattern that matches nothing is an error, not
// an empty run — a runner that silently runs zero files reports success.
import { readdirSync } from 'fs'
import path from 'path'

export function resolveFiles (args) {
  const files = []
  for (const arg of args) {
    if (!arg.includes('*')) { files.push(arg); continue }
    const dir = path.dirname(arg)
    const base = path.basename(arg)
    if (dir.includes('*') || !base.startsWith('*') || base.slice(1).includes('*')) {
      console.error(`Error: only a trailing dir/*.suffix pattern is supported: ${arg}`)
      process.exit(1)
    }
    const suffix = base.slice(1)
    const matches = readdirSync(path.resolve(dir))
      .filter((f) => f.endsWith(suffix))
      .sort()
      .map((f) => path.join(dir, f))
    if (matches.length === 0) {
      console.error(`Error: no files found when resolving ${arg}`)
      process.exit(1)
    }
    files.push(...matches)
  }
  return files
}
