#!/usr/bin/env node
// Produces every tray icon in resources/tray/.
//
// Linux + Windows show the full app icon, so those are derived from the files
// generate-app-icons.mjs already produced:
//
//   resources/win32/icon.ico              → resources/tray/tray.ico       (copy)
//   resources/linux/icons/32x32.png       → resources/tray/tray.png       (resize 22)
//   resources/linux/icons/64x64.png       → resources/tray/tray@2x.png    (resize 44)
//
// macOS does not: the menu bar takes a *template* image, so these are built
// from the brand SVG instead —
//
//   resources/brand/mirall-icon.svg       → resources/tray/mirallTrayTemplate.png    (18x16)
//                                         → resources/tray/mirallTrayTemplate@2x.png (36x32)
//
// A template image is an alpha mask: main.js calls `img.setTemplateImage(true)`
// and AppKit repaints the shape to suit the bar — black on a light menu bar,
// white on a dark one — so the RGB channels are discarded and only alpha
// survives. That is why the icon drops its cream rounded square (a filled
// background would read as a solid blob) and keeps only the M and the dot, and
// it is also what makes DOT_ALPHA work: partial alpha comes out as grey in
// either bar. Flat alpha rather than a dither — at 2x the dot is about 5px
// across and at 1x half that, too small to carry a pattern.
//
// Resizing uses `sips` (built-in on macOS). For other hosts, install
// ImageMagick and replace the sips call with `magick`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'resources', 'tray')
fs.mkdirSync(OUT, { recursive: true })

const BRAND_SVG = path.join(ROOT, 'resources', 'brand', 'mirall-icon.svg')
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron')
const RASTERIZE = path.join(ROOT, 'scripts', 'rasterize-svg.cjs')

// Menu-bar geometry, in 1x points. 14 of 16 matches the optical size of the
// template this replaces; the glyph is near-square, so the canvas is only a
// little wider than tall.
const GLYPH_H = 14
const CANVAS = { w: 18, h: 16 }
// The dot rendered at full strength sits within a pixel of the M's right stem
// at this size and reads as part of the letter. Dimming separates them.
const DOT_ALPHA = 0.65

/**
 * The brand icon reduced to its glyph: the cream rounded square dropped, the
 * orange dot recoloured to black at `DOT_ALPHA`, the M left as it is.
 *
 * Shapes are classified by fill colour, not by their order in the file —
 * successive exports have already shifted both the element order and the exact
 * values (rgb(251,249,245) vs (251,249,246), (251,156,67) vs (253,156,66)), and
 * silently building the glyph from the wrong shape is the kind of thing that
 * ships. Anything unexpected throws instead.
 */
function glyphOnlySvg() {
  const src = fs.readFileSync(BRAND_SVG, 'utf8')
  const shapes = src.match(/<g transform="matrix\([^"]*\)">\s*<(?:path|rect)[^>]*>\s*<\/g>/gs) ?? []
  const classify = (shape) => {
    const fill = shape.match(/fill:rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
    if (!fill) return 'glyph' // no fill -> SVG default black: the M
    const [r, g, b] = fill.slice(1).map(Number)
    if (r > 220 && g > 220 && b > 210) return 'background' // the cream square
    if (r > 200 && g > 100 && g < 200 && b < 120) return 'dot' // the orange dot
    return 'unknown'
  }
  const seen = { background: [], dot: [], glyph: [], unknown: [] }
  for (const shape of shapes) seen[classify(shape)].push(shape)
  for (const kind of ['background', 'dot', 'glyph']) {
    if (seen[kind].length !== 1) {
      throw new Error(`expected exactly one ${kind} shape in ${path.relative(ROOT, BRAND_SVG)}, found ${seen[kind].length}`)
    }
  }
  if (seen.unknown.length) throw new Error(`${seen.unknown.length} unrecognised shape(s) in ${path.relative(ROOT, BRAND_SVG)}`)

  return src
    .replace(seen.background[0], '')
    .replace(seen.dot[0], seen.dot[0].replace(/fill:rgb\([^)]*\)/, `fill:black;fill-opacity:${DOT_ALPHA}`))
}

/** One macOS template PNG: glyph scaled to `glyphH`, centred on the canvas. */
function template(glyphSvg, dest, glyphH, canvasW, canvasH) {
  const tmp = path.join(os.tmpdir(), `mirall-tray-${process.pid}`)
  fs.mkdirSync(tmp, { recursive: true })
  const svgFile = path.join(tmp, 'glyph.svg')
  const raster = path.join(tmp, 'glyph.png')
  try {
    fs.writeFileSync(svgFile, glyphSvg)
    // Supersample well above the target, then Lanczos down — a 14px glyph
    // rasterized natively comes out harsher than a downscaled one.
    execFileSync(ELECTRON, [RASTERIZE, svgFile, raster, '1024'], { stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('magick', [
      raster, '-trim', '+repage',
      '-resize', `x${glyphH}`,
      '-background', 'none', '-gravity', 'center', '-extent', `${canvasW}x${canvasH}`,
      '-depth', '8', '-strip', `PNG32:${dest}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    console.log(`built ${path.relative(ROOT, dest)} (${canvasW}x${canvasH}, glyph ${glyphH}px, ${fs.statSync(dest).size} B)`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function copy(src, dest) {
  fs.copyFileSync(src, dest)
  console.log(`copied ${path.relative(ROOT, src)} → ${path.relative(ROOT, dest)} (${fs.statSync(dest).size} B)`)
}

function resizePng(src, dest, size) {
  // sips replaces in-place when --out points at a different file. -Z scales
  // the longest side, preserving aspect ratio (square inputs stay square).
  execFileSync('sips', ['-Z', String(size), src, '--out', dest], { stdio: 'pipe' })
  console.log(`resized ${path.relative(ROOT, src)} → ${path.relative(ROOT, dest)} (${size}×${size}, ${fs.statSync(dest).size} B)`)
}

const winSrc = path.join(ROOT, 'resources', 'win32', 'icon.ico')
const linuxSmall = path.join(ROOT, 'resources', 'linux', 'icons', '32x32.png')
const linuxLarge = path.join(ROOT, 'resources', 'linux', 'icons', '64x64.png')

for (const f of [winSrc, linuxSmall, linuxLarge]) {
  if (!fs.existsSync(f)) {
    console.error(`missing source: ${f}`)
    process.exit(1)
  }
}

copy(winSrc, path.join(OUT, 'tray.ico'))
resizePng(linuxSmall, path.join(OUT, 'tray.png'), 22)
resizePng(linuxLarge, path.join(OUT, 'tray@2x.png'), 44)

// macOS menu-bar templates, built from the brand SVG rather than the app icon.
if (!fs.existsSync(BRAND_SVG)) {
  console.error(`missing source: ${BRAND_SVG}`)
  process.exit(1)
}
const glyph = glyphOnlySvg()
template(glyph, path.join(OUT, 'mirallTrayTemplate.png'), GLYPH_H, CANVAS.w, CANVAS.h)
template(glyph, path.join(OUT, 'mirallTrayTemplate@2x.png'), GLYPH_H * 2, CANVAS.w * 2, CANVAS.h * 2)
