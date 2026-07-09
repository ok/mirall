/**
 * analyze-chunkmap-blobs.mjs — quantify overlay chunk-map data sitting in a
 * Corestore RocksDB's `.blob` files, INCLUDING data orphaned from deleted cores
 * that `store.list()` can no longer see.
 *
 * Overlay never stores file content — only a chunk map per shared file, kept in the
 * `file-index` Hyperbee as `chunkmap:<path>` / `chunkmap-oid:<contentHash>` →
 * `[{hash, offset, length}, ...]` (paged for large files). Hyperbee stores those
 * arrays as core blocks; RocksDB blob-separates the large ones into `db/*.blob`.
 * When the owning file-index core is dropped without clearing its blocks, the JSON
 * stays physically in the `.blob` files as plaintext — which is what this scans.
 *
 * It byte-scans each `.blob` for `chunkmap` key markers, folds pages back to their
 * base key, and reports per shared file: chunk count, chunk-map bytes, and the
 * file's own size (max offset+length in its map). READ-ONLY.
 *
 * Usage:
 *   node_modules/.bin/bare scripts/analyze-chunkmap-blobs.mjs "<app-storage>/db"
 */
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'

const argv = (globalThis.Bare?.argv ?? globalThis.process?.argv ?? [])
const DB_DIR = argv.find((a) => typeof a === 'string' && a.endsWith('/db'))
  || (argv.find((a) => typeof a === 'string' && a.includes('app-storage'))
    ? path.join(argv.find((a) => a.includes('app-storage')), 'db')
    : '/Users/oliver/Library/Application Support/Mirall/app-storage/db')

const mb = (n) => (n / 1e6).toFixed(2) + ' MB'
const gb = (n) => (n / 1e9).toFixed(2) + ' GB'
const NEEDLE = b4a.from('chunkmap')
const OPEN = 0x5b // '['
const BRACE = 0x7b // '{'

// From a marker, read the key text up to the value start ('[' or '{'), tolerating
// the paging NUL. Returns { key, valStart } or null.
function readKey(buf, pos) {
  const end = Math.min(pos + 400, buf.length)
  for (let i = pos; i < end; i++) {
    const b = buf[i]
    if (b === OPEN || b === BRACE) {
      let keyEnd = i
      // trim a trailing non-key framing byte (e.g. value length prefix)
      while (keyEnd > pos && (buf[keyEnd - 1] < 0x20)) keyEnd--
      return { key: b4a.toString(buf.slice(pos, keyEnd), 'latin1'), valStart: i }
    }
  }
  return null
}

function analyzeFile(filePath, agg) {
  const buf = fs.readFileSync(filePath)
  const markers = []
  let i = 0
  while ((i = b4a.indexOf(buf, NEEDLE, i)) !== -1) { markers.push(i); i += NEEDLE.length }

  for (let m = 0; m < markers.length; m++) {
    const pos = markers[m]
    const parsed = readKey(buf, pos)
    if (!parsed) continue
    const regionEnd = m + 1 < markers.length ? markers[m + 1] : buf.length
    const region = b4a.toString(buf.slice(parsed.valStart, Math.min(regionEnd, parsed.valStart + 8 * 1024 * 1024)), 'latin1')

    const base = parsed.key.split('\x00')[0] // fold pages
    let rec = agg.get(base)
    if (!rec) { rec = { chunks: 0, valueBytes: 0, maxEnd: 0, pages: 0 }; agg.set(base, rec) }
    rec.pages++
    rec.valueBytes += regionEnd - parsed.valStart

    // chunk count + file size (max offset+length) from the JSON in this region
    let re
    const rx = /"offset":(\d+),"length":(\d+)/g
    let count = 0
    while ((re = rx.exec(region)) !== null) {
      count++
      const end = Number(re[1]) + Number(re[2])
      if (end > rec.maxEnd) rec.maxEnd = end
    }
    rec.chunks += count
  }
  return buf.length
}

function main() {
  console.log('# Chunk-map blob analysis')
  console.log('db dir:', DB_DIR)
  const blobs = fs.readdirSync(DB_DIR).filter((f) => f.endsWith('.blob'))
  console.log('blob files:', blobs.join(', '))
  console.log('')

  const agg = new Map() // base chunk-map key → stats
  let scanned = 0
  for (const f of blobs) scanned += analyzeFile(path.join(DB_DIR, f), agg)

  const rows = [...agg.entries()].map(([key, r]) => ({ key, ...r }))
  rows.sort((a, b) => b.valueBytes - a.valueBytes)

  const totalMapBytes = rows.reduce((n, r) => n + r.valueBytes, 0)
  const totalChunks = rows.reduce((n, r) => n + r.chunks, 0)
  console.log('## Summary')
  console.log('scanned blob bytes :', mb(scanned))
  console.log('distinct chunk maps:', rows.length, '(unique files / content hashes)')
  console.log('total chunk entries:', totalChunks.toLocaleString())
  console.log('total chunk-map bytes (approx):', mb(totalMapBytes))
  console.log('')

  console.log('## Chunk maps by size (top 30)')
  console.log('  chunkmap bytes     chunks    file size          key')
  for (const r of rows.slice(0, 30)) {
    const label = r.key.length > 60 ? r.key.slice(0, 60) + '…' : r.key
    console.log(
      '  ' + mb(r.valueBytes).padStart(11) +
      '   ' + String(r.chunks).padStart(8) +
      '   ' + (r.maxEnd >= 1e9 ? gb(r.maxEnd) : mb(r.maxEnd)).padStart(10) +
      '   ' + label,
    )
  }
  console.log('\n# done')
}

main()
