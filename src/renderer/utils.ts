import i18n from './i18n.js'
import { formatSize as formatSizeImpl } from './formatSize.js'

// getFileIcon and formatSize live in pure, dependency-free modules so they can be
// unit-tested by the brittle-node suite; re-exported / wrapped here for callers.
export { getFileIcon } from './fileIcon.js'

const AVATAR_SIZE = 160

// Imported, not mirrored. The contract package is plain ESM with no imports of its own, so esbuild
// bundles it into the renderer and Bare loads the same file in the worker — one declaration, and the
// "keep in sync" comment that used to stand here is now a build error instead of a hope.
import { NAME_MAX, AVATAR_MAX_BYTES } from '../shared/contract/limits.js'
export { NAME_MAX, AVATAR_MAX_BYTES }
export const AVATAR_INPUT_MAX_BYTES = 16 * 1024 * 1024

export function getInitials(displayName: string | null | undefined): string {
  if (!displayName) return '?'
  const words = displayName.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0][0]!.toUpperCase()
  return (words[0][0]! + words[words.length - 1][0]!).toUpperCase()
}

export function resizeAvatar(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = AVATAR_SIZE
      canvas.height = AVATAR_SIZE
      const ctx = canvas.getContext('2d')!

      const side = Math.min(img.width, img.height)
      const sx = (img.width - side) / 2
      const sy = (img.height - side) / 2

      ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
      let quality = 0.85
      let out = canvas.toDataURL('image/jpeg', quality)
      while (out.length > AVATAR_MAX_BYTES && quality > 0.4) {
        quality -= 0.15
        out = canvas.toDataURL('image/jpeg', quality)
      }
      resolve(out)
    }
    img.onerror = reject
    img.src = dataUrl
  })
}

export function formatSize(bytes: number | undefined): string {
  return formatSizeImpl(bytes, i18n.language)
}

export function formatSpeed(bytesPerSec: number | undefined): string {
  return formatSize(bytesPerSec) + '/s'
}

function formatEta(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return ''
  const total = Math.round(seconds)
  if (total < 60) return i18n.t('format.etaSecondsLeft', { value: total })
  const mins = Math.floor(total / 60)
  const secs = total % 60
  if (mins < 60) return i18n.t('format.etaMinutesLeft', { minutes: mins, seconds: secs })
  const hrs = Math.floor(mins / 60)
  return i18n.t('format.etaHoursLeft', { hours: hrs, minutes: mins % 60 })
}

export interface EtaDisplay {
  indeterminate: boolean
  etaText: string
}

// Resolve a worker ETA (null = estimating/warmup, 0 or undefined = none, > 0 = seconds)
// plus the live display speed into what the progress lane should show. A transfer whose
// speed has decayed to 0 (stalled) hides a now-stale ETA instead of freezing it; warmup
// shows "Estimating…"; a still-live transfer shows the formatted time. Sources without a
// speed sampler (publish/index) pass avgSpeed undefined and always show the ETA.
export function resolveEta(eta: number | null | undefined, avgSpeed?: number | null): EtaDisplay {
  if (eta === null) return { indeterminate: true, etaText: i18n.t('format.etaEstimating') }
  if (eta && eta > 0 && (avgSpeed == null || avgSpeed > 0)) return { indeterminate: false, etaText: formatEta(eta) }
  return { indeterminate: false, etaText: '' }
}

// Serve-side ETA: the publisher has no worker estimator for peers pulling from us
// (that's a receiver-only signal), so derive remaining ÷ observed throughput from the
// summary/per-peer bytes the SpeedSampler already tracks. Returns '' when speed has
// decayed to 0 (idle/stalled) or the pull is complete — never the receiver-only
// "Estimating…" warmup text, since 0 here means idle, not warming up.
export function etaFromRate(bytes: number, total: number, avgSpeed: number): string {
  const remaining = total - bytes
  if (!(avgSpeed > 0) || remaining <= 0) return ''
  // avgSpeed > 0 is already guaranteed above, so resolveEta's stall-guard never fires here.
  return resolveEta(remaining / avgSpeed).etaText
}

// One definition of a progress meta line and its screen-reader twin, shared by the
// download lane, the collapsed serve indicator, and the per-peer row so the visible
// text and the aria-valuetext can't drift apart. joinMeta drops empty tokens and joins
// with ' · '; progressValueText leads with the percentage (the bar's primary signal),
// then the same tokens, comma-separated for natural screen-reader phrasing.
export function joinMeta(...tokens: Array<string | null | undefined>): string {
  return tokens.filter(Boolean).join(' · ')
}

export function progressValueText(pct: number, ...tokens: Array<string | null | undefined>): string {
  return [`${pct}%`, ...tokens].filter(Boolean).join(', ')
}

export function formatDate(iso: string | number | Date): string {
  return new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(iso))
}

export function fileName(path: string): string {
  return path.split('/').pop() || path
}

// Each space picks one slot via a deterministic hash of its ID (see
// gradientForSpaceId below). Palette is curated to sit harmoniously next to
// the brand plum/orange: four warm tones, three cooler complements for
// variety. Light-mode values are deep enough to keep ~4.5:1 contrast against
// white icon glyphs; dark-mode values are light enough for the dark glyph.
const SPACE_GRADIENTS = [
  'bg-[#c66514] dark:bg-[#fdb461]',
  'bg-[#6e2c46] dark:bg-[#c87b95]',
  'bg-[#ad3d35] dark:bg-[#e87b6f]',
  'bg-[#7a5414] dark:bg-[#e0b85a]',
  'bg-[#4e7045] dark:bg-[#a3c98e]',
  'bg-[#1f6660] dark:bg-[#6abab1]',
  'bg-[#4e3f80] dark:bg-[#9c8fd6]',
]

export function gradientForSpaceId(spaceId: string): string {
  let h = 0
  for (let i = 0; i < spaceId.length; i++) h = (h * 31 + spaceId.charCodeAt(i)) | 0
  return SPACE_GRADIENTS[Math.abs(h) % SPACE_GRADIENTS.length]
}
