#!/usr/bin/env node
// Regenerates every platform app icon from the one brand SVG in
// resources/brand/mirall-icon.svg. Run it after the designer ships a new icon;
// the generated PNG/ICNS/ICO files are committed, so a build never needs any of
// this.
//
// Chromium rasterizes the SVG (scripts/rasterize-svg.cjs) and ImageMagick does
// the rest — resizing, compositing, the ICO. `magick` is deliberately never
// pointed at the .svg: see rasterize-svg.cjs for the facetted corners that
// caused.
//
// There are two brand sources, differing only in the corner radius of the
// rounded square. macOS gets the Apple squircle; Windows 11's icon grid uses a
// far tighter radius, and Linux follows Windows rather than Apple here.
//
//   resources/darwin/icon.icns          macOS app icon (Apple grid + shadow)
//   resources/darwin/dmg/VolumeIcon.icns  mounted-DMG volume icon
//   resources/linux/icon.png            1024² AppImage / Notification icon
//   resources/linux/icons/*.png         freedesktop hicolor sizes
//   resources/win32/icon.ico            Windows app + Notification icon
//   resources/win32/msix-assets/*.png   MSIX tile / store / target-size assets
//
// Afterwards run `node scripts/generate-tray-icons.mjs` — the Linux and Windows
// tray icons are derived from the files above and would otherwise still show
// the previous artwork.
//
// macOS is the odd one out. Its icons are not edge-to-edge: Apple's grid insets
// the rounded square to 824² inside a 1024² canvas and casts a shadow into the
// margin, which is what makes a Dock icon sit at the same optical size as its
// neighbours. The ambient + directional shadow constants below were fitted
// against the icon this script replaces, so the treatment carries over
// unchanged. Every other platform draws the square edge-to-edge.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// macOS: the Apple squircle. Also the source for the menu-bar template glyph
// (generate-tray-icons.mjs), where the square is stripped and only M + dot
// remain, so the radius is irrelevant there.
const SRC = path.join(ROOT, 'resources', 'brand', 'mirall-icon.svg')
// Windows + Linux: the tighter Windows 11 radius. Same M and dot, different
// rounded square.
const SRC_WIN11 = path.join(ROOT, 'resources', 'brand', 'mirall-icon-win11.svg')
// The DMG volume icon is a composed drive graphic, not a render of the app
// icon: the mark sits inlaid on the drive's face, at its own size, and the
// inlay is not even square. It comes in as a finished 1024 PNG exported from
// the designer's mirall-dmg-icon.pxd — this script only cuts it into an .icns.
const DMG_SRC = path.join(ROOT, 'resources', 'brand', 'mirall-dmg-icon.png')

// Rasterize once at SUPERSAMPLE px and downsample from there, rather than
// asking the renderer for each size directly: small sizes come out far cleaner
// from a Lanczos downscale than from a 16px rasterization of a rounded
// rectangle. Chromium renders to an exact pixel size, so the source document's
// own units — 703pt in one export, 2500 in the next — never enter into it.
const SUPERSAMPLE = 2048
const MASTER = 1024

// Apple's macOS icon grid, in 1024² canvas units.
const MAC_BODY = 824
const MAC_X = 100
const MAC_Y = 90
// Ambient (centred) + directional (dropped) shadow: opacity fraction, blur sigma.
const MAC_SHADOW_AMBIENT = { opacity: 0.18, sigma: 4 }
const MAC_SHADOW_DIRECT = { opacity: 0.4, sigma: 6, dy: 9 }

const ICNS_SIZES = [16, 32, 128, 256, 512]
const LINUX_SIZES = [16, 32, 48, 64, 128, 256]
const ICO_SIZES = [16, 32, 48, 64, 128, 256]
// Names and pixel sizes are fixed by AppxManifest.xml and the Windows shell.
// The `_altform-unplated` twins are byte-identical to their plated siblings:
// the artwork already carries its own opaque background, so there is nothing
// for the plate to add.
const MSIX_ASSETS = [
  ['Square150x150Logo.png', 150],
  ['Square71x71Logo.png', 71],
  ['Square44x44Logo.png', 44],
  ['StoreLogo.png', 50],
  ...[16, 24, 32, 48, 256].flatMap((n) => [
    [`Square44x44Logo.targetsize-${n}.png`, n],
    [`Square44x44Logo.targetsize-${n}_altform-unplated.png`, n],
  ]),
]

const HINTS = { magick: 'ImageMagick 7 — brew install imagemagick' }

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`missing required tool: ${cmd}${HINTS[cmd] ? ` (${HINTS[cmd]})` : ''}`)
      process.exit(1)
    }
    console.error(`${cmd} failed: ${err.stderr?.toString().trim() || err.message}`)
    process.exit(1)
  }
}

function report(file) {
  console.log(`  ${path.relative(ROOT, file)} (${fs.statSync(file).size} B)`)
}

function identify(file, format) {
  return execFileSync('magick', ['identify', '-format', format, file], { encoding: 'utf8' }).trim()
}

const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron')
const RASTERIZE = path.join(ROOT, 'scripts', 'rasterize-svg.cjs')

/** Rasterize a brand SVG to a `size`x`size` PNG via Chromium. */
function rasterize(src, dest, size) {
  if (!fs.existsSync(ELECTRON)) {
    console.error(`missing ${path.relative(ROOT, ELECTRON)} — run: npm install (or npm rebuild electron)`)
    process.exit(1)
  }
  run(ELECTRON, [RASTERIZE, src, dest, String(size)])
  if (!fs.existsSync(dest)) {
    console.error('rasterize-svg produced no output')
    process.exit(1)
  }
}

/**
 * Square PNG at `size`, downsampled from the rasterized master.
 *
 * Neither flag is cosmetic. `-depth 8`: this is a Q16 ImageMagick build, so
 * without it every PNG comes out 16-bit — twice the bytes for precision no
 * icon renderer looks at. `PNG32:`: ImageMagick writes whatever channel layout
 * it thinks the pixels need, and the moment one intermediate lands on
 * greyscale every later composite against it drops colour silently (this ate
 * the orange dot on the macOS icon once already).
 */
function square(master, dest, size) {
  run('magick', [master, '-resize', `${size}x${size}`, '-depth', '8', '-strip', `PNG32:${dest}`])
}

/** Cut a 1024 master into a full .iconset and let iconutil seal it into `dest`. */
function buildIcns(master, name, dest) {
  const iconset = path.join(tmp, `${name}.iconset`)
  fs.mkdirSync(iconset, { recursive: true })
  for (const size of ICNS_SIZES) {
    square(master, path.join(iconset, `icon_${size}x${size}.png`), size)
    square(master, path.join(iconset, `icon_${size}x${size}@2x.png`), size * 2)
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', dest])
  report(dest)
}

/**
 * ICO with a PNG payload per entry. ImageMagick only writes uncompressed BMP
 * entries (370 KB for this set against 17 KB here), and every Windows the app
 * supports reads PNG-in-ICO — which is what the icon this replaces already
 * shipped, on the exe, the tray and the MSIX alike.
 */
function writeIco(pngs, dest) {
  const HEADER = 6
  const ENTRY = 16
  const dir = Buffer.alloc(HEADER + ENTRY * pngs.length)
  dir.writeUInt16LE(0, 0) // reserved
  dir.writeUInt16LE(1, 2) // type: icon
  dir.writeUInt16LE(pngs.length, 4)
  let offset = dir.length
  const payloads = []
  pngs.forEach(({ size, file }, i) => {
    const data = fs.readFileSync(file)
    const at = HEADER + ENTRY * i
    dir.writeUInt8(size >= 256 ? 0 : size, at) // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1)
    dir.writeUInt8(0, at + 2) // palette size: 0 for true colour
    dir.writeUInt8(0, at + 3) // reserved
    dir.writeUInt16LE(1, at + 4) // colour planes
    dir.writeUInt16LE(32, at + 6) // bits per pixel
    dir.writeUInt32LE(data.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += data.length
    payloads.push(data)
  })
  fs.writeFileSync(dest, Buffer.concat([dir, ...payloads]))
}

/**
 * A 1024 edge-to-edge master from one brand SVG.
 *
 * The raster is cropped to the artwork before anything else. An export may sit
 * on an artboard with its own margin (the macOS one leaves ~1%, the Windows one
 * ~0.1%), and inheriting that would shrink the icon on every platform — and
 * push the macOS body off Apple's 824 grid, which is measured against the
 * artwork, not the artboard. Padding is this script's decision to make per
 * platform, so the source's own is stripped first.
 */
function makeMaster(src, label) {
  if (!fs.existsSync(src)) {
    console.error(`missing source: ${src}`)
    process.exit(1)
  }
  const raster = path.join(tmp, `${label}-raster.png`)
  const trimmed = path.join(tmp, `${label}-trimmed.png`)
  const master = path.join(tmp, `${label}-master.png`)
  rasterize(src, raster, SUPERSAMPLE)
  run('magick', [raster, '-trim', '+repage', `PNG32:${trimmed}`])
  const [tw, th] = identify(trimmed, '%w %h').split(' ').map(Number)
  const side = Math.max(tw, th)
  run('magick', [trimmed, '-background', 'none', '-gravity', 'center', '-extent', `${side}x${side}`,
    '-resize', `${MASTER}x${MASTER}`, '-depth', '8', '-strip', `PNG32:${master}`])
  console.log(`source (${label}): ${path.relative(ROOT, src)} → ${identify(raster, '%wx%h')} raster, artwork ${tw}x${th}`)
  return master
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-icons-'))

try {
  if (!fs.existsSync(SRC)) {
    console.error(`missing source: ${SRC}`)
    process.exit(1)
  }
  const master = makeMaster(SRC, 'macos')
  const masterWin11 = makeMaster(SRC_WIN11, 'win11')

  // ---- macOS ----------------------------------------------------------------
  // iconutil is macOS-only, so a non-Mac host regenerates everything else and
  // leaves the committed .icns alone rather than failing the whole run.
  if (process.platform === 'darwin') {
    console.log('macOS:')
    const body = path.join(tmp, 'mac-body.png')
    const canvas = path.join(tmp, 'mac-canvas.png')
    const ambient = path.join(tmp, 'mac-ambient.png')
    const direct = path.join(tmp, 'mac-direct.png')
    const shadowMask = path.join(tmp, 'mac-shadow-mask.png')
    const shadow = path.join(tmp, 'mac-shadow.png')
    const macMaster = path.join(tmp, 'mac-master.png')

    square(master, body, MAC_BODY)
    run('magick', ['-size', `${MASTER}x${MASTER}`, 'xc:none', body, '-geometry', `+${MAC_X}+${MAC_Y}`, '-composite', `PNG32:${canvas}`])

    // Both shadows are the body's own silhouette, blurred and dimmed; the
    // directional one is rolled down first. Screen-compositing them keeps the
    // overlap from doubling into a hard rim.
    const blurLayer = (dest, { opacity, sigma, dy = 0 }) => run('magick', [
      canvas, '-alpha', 'extract',
      ...(dy ? ['-roll', `+0+${dy}`] : []),
      '-blur', `0x${sigma}`,
      '-evaluate', 'multiply', String(opacity),
      dest,
    ])
    blurLayer(ambient, MAC_SHADOW_AMBIENT)
    blurLayer(direct, MAC_SHADOW_DIRECT)
    run('magick', [ambient, direct, '-compose', 'Screen', '-composite', shadowMask])
    run('magick', ['-size', `${MASTER}x${MASTER}`, 'xc:black', '-alpha', 'off', shadowMask, '-compose', 'CopyOpacity', '-composite', `PNG32:${shadow}`])
    run('magick', [shadow, canvas, '-compose', 'Over', '-composite', '-depth', '8', '-strip', `PNG32:${macMaster}`])

    buildIcns(macMaster, 'app', path.join(ROOT, 'resources', 'darwin', 'icon.icns'))

    // The volume icon needs none of the treatment above — no grid inset, no
    // shadow. It arrives already composed and already carries the drive's own
    // shadow, so it goes straight from the source PNG into an .iconset.
    if (fs.existsSync(DMG_SRC)) {
      buildIcns(DMG_SRC, 'volume', path.join(ROOT, 'resources', 'darwin', 'dmg', 'VolumeIcon.icns'))
    } else {
      console.log(`  skipped VolumeIcon.icns — ${path.relative(ROOT, DMG_SRC)} is missing`)
    }
  } else {
    console.log('macOS: skipped (iconutil is macOS-only) — resources/darwin/icon.icns left as committed')
  }

  // ---- Linux ----------------------------------------------------------------
  console.log('Linux:')
  const linuxIcon = path.join(ROOT, 'resources', 'linux', 'icon.png')
  fs.copyFileSync(masterWin11, linuxIcon)
  report(linuxIcon)
  const hicolor = path.join(ROOT, 'resources', 'linux', 'icons')
  fs.mkdirSync(hicolor, { recursive: true })
  for (const size of LINUX_SIZES) {
    const dest = path.join(hicolor, `${size}x${size}.png`)
    square(masterWin11, dest, size)
    report(dest)
  }

  // ---- Windows --------------------------------------------------------------
  console.log('Windows:')
  const ico = path.join(ROOT, 'resources', 'win32', 'icon.ico')
  writeIco(ICO_SIZES.map((size) => {
    const file = path.join(tmp, `ico-${size}.png`)
    square(masterWin11, file, size)
    return { size, file }
  }), ico)
  report(ico)
  const msix = path.join(ROOT, 'resources', 'win32', 'msix-assets')
  fs.mkdirSync(msix, { recursive: true })
  for (const [name, size] of MSIX_ASSETS) {
    const dest = path.join(msix, name)
    square(masterWin11, dest, size)
    report(dest)
  }

  console.log('\nNow run: node scripts/generate-tray-icons.mjs')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
