// Full-bleed Drop-to-Share overlay test (LOCAL/dev-machine only — spawns a real
// Electron GUI process, like the agent-desktop frontend suite). Mounts the real
// <SpaceView> in real Chromium, dispatches synthetic DragEvents, and asserts the
// crossfade, geometry (top edge == resting-zone top; sides/bottom == content grid),
// the file/folder copy, and reset-on-leave.
//
//   node test/frontend-layout/run-dropoverlay.mjs            (builds, then runs)
//   node test/frontend-layout/run-dropoverlay.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-dropoverlay.html', height: 900 })

console.log('\n──────── SpaceView Drop-to-Share overlay harness ────────')
console.log(`idle      : opacity=${out.idleOpacity} ariaHidden=${out.idleHidden} shareReachable=${out.shareReachable}`)
console.log(`text drag : ignored=${out.textIgnored} (overlay must stay hidden for non-file drags)`)
console.log(`files drag: overlay=${out.filesActiveOpacity} smallZone=${out.smallFaded} sub="${out.filesSub}" geomOk=${out.geomOk}`)
console.log(`folder drag: sub="${out.folderSub}"`)
console.log(`after leave: overlay=${out.afterLeaveOpacity}`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} full-bleed overlay crossfades in on drag (file/folder copy + geometry) and resets on leave`)
process.exit(pass ? 0 : 1)
