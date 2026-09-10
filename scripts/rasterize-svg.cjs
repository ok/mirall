#!/usr/bin/env electron
// Rasterizes an SVG to a PNG with the Electron already in devDependencies:
//   electron scripts/rasterize-svg.cjs <in.svg> <out.png> <size>
// <size> is `N` for N x N or `WxH` (the wordmark is 2835:844 and must not be squared).
//
// Not ImageMagick: `magick` renders SVG itself only when librsvg is absent, and its own renderer
// flattens Béziers in the path's coordinate space — the brand icon is a unit-scale path scaled ~147x,
// so every corner comes out faceted, silently. Chromium has no such mode, needs no system install,
// and is the engine that paints the app; drawing into a canvas keeps the result independent of
// window size, display scaling and compositing.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')

const [svgPath, outPath, sizeArg] = process.argv.slice(2)
const [width, height] = String(sizeArg ?? '').split('x').map(Number)
const h = Number.isFinite(height) ? height : width

if (!svgPath || !outPath || !Number.isInteger(width) || width <= 0 || !Number.isInteger(h) || h <= 0) {
  console.error('usage: electron scripts/rasterize-svg.cjs <in.svg> <out.png> <N|WxH>')
  app.exit(2)
}

// Deterministic across machines, and the GPU buys nothing for one canvas draw.
app.disableHardwareAcceleration()

/** The SVG resized to exactly WxH, so Chromium rasterizes 1:1 into the canvas. */
function svgAtSize(source) {
  return source.replace(/<svg\b[^>]*>/, (tag) => tag
    .replace(/\swidth="[^"]*"/, '')
    .replace(/\sheight="[^"]*"/, '')
    .replace('<svg', `<svg width="${width}" height="${h}"`))
}

app.whenReady().then(async () => {
  let win
  try {
    const svg = svgAtSize(fs.readFileSync(svgPath, 'utf8'))
    const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64')

    win = new BrowserWindow({ show: false, width: 64, height: 64 })
    await win.loadURL('data:text/html,<meta charset="utf-8">')

    const png = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image()
      img.src = ${JSON.stringify(dataUrl)}
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = ${width}
      canvas.height = ${h}
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, ${width}, ${h})
      return canvas.toDataURL('image/png')
    })()`)

    const body = png.split(',')[1]
    if (!body) throw new Error('canvas produced no PNG data')
    fs.writeFileSync(outPath, Buffer.from(body, 'base64'))
    app.exit(0)
  } catch (err) {
    console.error(`rasterize-svg: ${err?.message || err}`)
    app.exit(1)
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
})
