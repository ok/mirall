// Peer-download serve-UI test (LOCAL/dev-machine only — spawns a real Electron GUI
// process, like the agent-desktop frontend suite). Mounts the real
// <PeerDownloadIndicator> at several lane widths + locales and the <PeerDownloadRow> in real
// Chromium and asserts the collapsed meta never clips, the count word sheds first (shown only
// on a wide folder lane), speed is always kept, ETA sheds next, the per-peer row right-aligns
// the avatar + bar with the name yielding, and the progressbar aria-valuetext stays complete.
//
//   node test/frontend-layout/run-peerdownload.mjs            (builds, then runs)
//   node test/frontend-layout/run-peerdownload.mjs --no-build (reuse existing bundle)
import { runHarness } from './run-harness.mjs'

const out = await runHarness({ html: 'harness-peerdownload.html', height: 480 })

console.log('\n──────── Peer-download serve UI harness ────────')
console.log(`clip (all false): folder=${out.clipFolder} file=${out.clipFile} narrow=${out.clipNarrow} tiny=${out.clipTiny} de=${out.clipDe}`)
console.log(`count word shown: folder=${out.countShown.folder} (true) · file=${out.countShown.file} narrow=${out.countShown.narrow} tiny=${out.countShown.tiny} (false)`)
console.log(`speed always / eta@narrow / eta@tiny: ${out.speedAll} / ${out.etaNarrow} / ${out.etaTiny}  (true / true / false)`)
console.log(`aria file: "${out.ariaFile}"`)
console.log(`aria tiny: "${out.ariaTiny}"   (must still carry count + ETA)`)
console.log(`per-peer live   : text="${out.rowLiveText}"  aria="${out.rowLiveValueText}"`)
console.log(`per-peer clip   : name clipped=${out.rowLiveNameClipped}  speed·ETA clipped=${out.rowLiveMetaClipped} (name must yield, speed·ETA must not)`)
console.log(`per-peer bar    : ${(out.rowLiveBarRatio * 100).toFixed(0)}% of the row, right gap=${out.rowLiveBarRightGap.toFixed(0)}px (right-aligned, ~half width)`)
console.log(`per-peer name   : ${out.rowLiveNameAvatarGap.toFixed(0)}px from the avatar (must be next to it, ~12px)`)
console.log(`per-peer warmup : "${out.rowWarmText}"   (must show % fallback, not blank)`)
console.log(`per-peer offline: "${out.rowOffText}"`)

const pass = out.pass === true
console.log(`\n${pass ? 'ok  ' : 'FAIL'} meta un-clipped at every lane + locale; count word sheds first, speed always kept, aria-valuetext complete; per-peer row name yields`)
process.exit(pass ? 0 : 1)
