// Indexing-label test (LOCAL/dev-machine only — spawns a real Electron GUI process).
// Mounts the real <FolderTree> for an owner mid-index, a member waiting on that index, and a
// member with a real download alongside, then reads back the roll-up badge, the row pill and
// the progress bar's accessible name for each.
//
//   node test/frontend-layout/run-indexing.mjs            (builds, then runs)
//   node test/frontend-layout/run-indexing.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-indexing.html', height: 900, width: 1280 })

console.log('\n──────── FolderView indexing labels ────────')
console.log(`owner  : folder "${out.ownFolderText.trim()}"`)
console.log(`         row pill "${out.ownRowText.includes('Adding') ? 'Adding' : out.ownRowText.trim()}", bar "${out.ownBarLabel}"`)
console.log(`member : folder "${out.memberFolderText.trim()}"`)
console.log(`         row pill "${out.memberRowText.includes('Preparing') ? 'Preparing…' : out.memberRowText.trim()}", bar "${out.memberBarLabel}"`)
console.log(`mixed  : folder "${out.mixedFolderText.trim()}", download bar "${out.downloadBarLabel}"`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} an indexing folder never claims a download, and its bar is named for the indexing it measures`)
process.exit(pass ? 0 : 1)
