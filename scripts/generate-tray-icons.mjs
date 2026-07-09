#!/usr/bin/env node
// Produces Linux + Windows tray icons in resources/tray/ from the existing
// app icons in resources/. macOS template icons are user-provided.
//
//   resources/win32/icon.ico              → resources/tray/tray.ico       (copy)
//   resources/linux/icons/32x32.png       → resources/tray/tray.png       (resize 22)
//   resources/linux/icons/64x64.png       → resources/tray/tray@2x.png    (resize 44)
//
// Resizing uses `sips` (built-in on macOS). For other hosts, install
// ImageMagick and replace the sips call with `magick`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'resources', 'tray')
fs.mkdirSync(OUT, { recursive: true })

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
