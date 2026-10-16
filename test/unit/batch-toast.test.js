import test from 'brittle'
import { batchNotes, batchToastText } from '../../src/renderer/model/batch-toast.js'

// Echoes the key and its count, so an assertion reads which sentence was chosen.
const t = (key, vars = {}) => (vars.count === undefined ? key : `${key}(${vars.count})`)
const MOVED = 'Downloads from Studio now go to Press kit'
const counts = (over = {}) => ({ started: 2, alreadyHere: 0, waitingOnOwner: 0, removed: 0, failed: 0, ...over })

test('batchNotes names what did not start, in order, and nothing for a mirrored folder', (t2) => {
  t2.alike(batchNotes(counts({ alreadyHere: 2, waitingOnOwner: 1, removed: 1, failed: 3 }), t),
    ['batch.onDevice(2)', 'batch.waitingOnOwner(1)', 'batch.removedUpstream(1)', 'batch.failed(3)'])
  t2.alike(batchNotes(counts(), t), [])
  t2.alike(batchNotes({ mirrored: true }, t), [])
})

test('a batch into the space\'s own folder says only its notes, or nothing', (t2) => {
  t2.is(batchToastText({ results: [counts()], moved: MOVED, t }), null)
  t2.is(batchToastText({ results: [counts({ alreadyHere: 2 })], moved: MOVED, t }), 'batch.onDevice(2)')
})

test('with several owners, one response saying the folder changed is enough', (t2) => {
  const results = [counts({ folderChanged: true }), counts({ waitingOnOwner: 1 })]
  t2.is(batchToastText({ results, moved: MOVED, t }), `${MOVED} · batch.waitingOnOwner(1)`)
})

// REGRESSION (FIX-DLTO-R16: the batch toasted a renderer-guessed "now go to" — after every request
// was refused and nothing moved, and a second time under the bridge's id when it had).
test('REGRESSION (FIX-DLTO-R16: the batch says "now go to" only when the worker moved the folder, and only with notes)', (t2) => {
  t2.is(batchToastText({ results: [], moved: MOVED, t }), null, 'every request refused: nothing moved, the error toast says why')
  t2.is(batchToastText({ results: [counts({ folderChanged: true })], moved: MOVED, t }), null,
    'moved with nothing to add: DownloadToToastBridge already named the folder')
  t2.is(batchToastText({ results: [counts({ folderChanged: true, alreadyHere: 2 })], moved: MOVED, t }), `${MOVED} · batch.onDevice(2)`,
    'moved with notes: the sentence leads them')
})
