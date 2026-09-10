import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.resolve(here, '../../src/renderer')

function tsxFiles (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) tsxFiles(p, out)
    else if (name.endsWith('.tsx')) out.push(p)
  }
  return out
}

const files = tsxFiles(RENDERER).map((f) => ({
  rel: path.relative(RENDERER, f).split(path.sep).join('/'),
  src: readFileSync(f, 'utf8'),
}))

// The bodies of every `catch`/`finally` clause in a source, by brace matching. A regex cannot see
// where a clause ends, and "the setter is somewhere in the file" is exactly the assertion that
// passed while the setter sat on the resolve-only path.
function guardBlocks (src) {
  const blocks = []
  for (const m of src.matchAll(/\b(catch|finally)\b/g)) {
    const open = src.indexOf('{', m.index)
    if (open === -1) continue
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) { blocks.push(src.slice(open, i + 1)); break }
      }
    }
  }
  return blocks
}

// A dialog that refuses Escape and the backdrop while an operation runs (`isDismissable={!busy}`)
// holds every exit route behind that one flag. The flag therefore has to be cleared on the
// REJECTION path too — from a catch or a finally — or a failed confirm strands the dialog with no
// way out at all.
test('REGRESSION (FIX-D8/FIX-D9: a busy dialog clears its busy flag when the operation rejects)', (t) => {
  const dialogs = files.filter((f) => /isDismissable=\{!\w+\}/.test(f.src))
  t.ok(dialogs.length >= 4, `found ${dialogs.length} dialogs that gate dismissal on a busy flag`)
  for (const f of dialogs) {
    const flag = f.src.match(/isDismissable=\{!(\w+)\}/)[1]
    const clear = `set${flag[0].toUpperCase()}${flag.slice(1)}(false)`
    t.ok(f.src.includes(clear), `${f.rel}: ${clear} exists`)
    t.ok(guardBlocks(f.src).some((b) => b.includes(clear)),
      `${f.rel}: ${clear} runs from a catch/finally, so a rejection cannot strand the dialog`)
  }
})

// The other half of the same trap: while the busy flag refuses Escape and the backdrop, the header
// ✕ must not stay live — it is the one exit the busy state claims is unsafe. Every close button a
// busy dialog renders is therefore disabled from the flag, except where the header is on the
// dialog's non-busy branch and so is not on screen at all while the operation runs.
const CLOSE_OFF_BUSY_BRANCH = new Map([
  // LeaveSpaceModal renders two headers: the progress step's carries no close button, and the one
  // below is the confirm step, which `leaving` has already replaced by the time it could matter.
  ['components/modals/LeaveSpaceModal.tsx', 1],
])

function modalHeaderElements (src) {
  const els = []
  for (const m of src.matchAll(/<ModalHeader\b/g)) {
    // Scan to the element's own closing `>`, tracking `{}` depth: the first `/>` in the source
    // usually belongs to a nested element inside a prop (`titleNode={<FilenameTitle … />}`).
    let depth = 0
    for (let i = m.index; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
      else if (src[i] === '>' && depth === 0) { els.push(src.slice(m.index, i + 1)); break }
    }
  }
  return els
}

test('REGRESSION (FIX-D8: a busy dialog disables every close button it renders while busy)', (t) => {
  const dialogs = files.filter((f) => /isDismissable=\{!\w+\}/.test(f.src))
  for (const f of dialogs) {
    const flag = f.src.match(/isDismissable=\{!(\w+)\}/)[1]
    const closable = modalHeaderElements(f.src).filter((el) => el.includes('onClose'))
    const exempt = CLOSE_OFF_BUSY_BRANCH.get(f.rel) || 0
    const guarded = closable.filter((el) => el.includes(`closeDisabled={${flag}}`)).length
    t.is(guarded, closable.length - exempt,
      `${f.rel}: ${closable.length - exempt} of ${closable.length} close button(s) disabled while ${flag}`)
  }
})

// A `finally` runs on rejection as well as on resolve, so a completion callback placed there
// reports success for an operation that failed — and for a leave, navigates the user out of a
// space they are still in.
test('REGRESSION (FIX-D9: no dialog reports completion from a finally block)', (t) => {
  const COMPLETION = ['onComplete', 'onCreated', 'onMounted', 'onSaved', 'onDone', 'onSuccess']
  for (const f of files) {
    for (const block of guardBlocks(f.src)) {
      for (const cb of COMPLETION) {
        if (block.includes(`${cb}(`)) {
          t.fail(`${f.rel}: ${cb}() runs from a catch/finally — it would report a failed operation as done`)
        }
      }
    }
  }
  t.pass('no completion callback runs from a catch/finally')
})
