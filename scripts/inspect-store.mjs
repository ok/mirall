/**
 * inspect-store.mjs — read-only forensic dump of a Mirall Corestore / RocksDB store.
 *
 * Answers "what is actually on disk and which core holds it": enumerates every
 * hypercore in the store by discovery key with its logical byteLength, classifies
 * each (profile / catalog / overlay file-index / hyperdrive-db / other), then deep-
 * dives the overlay file-index bee to break down chunk-map / tree / file entries by
 * key prefix and per shared file.
 *
 * READ-ONLY: opens the store, reads metadata + values, never writes. Run only with
 * the app fully closed (RocksDB is single-writer; there must be no lock holder).
 *
 * Usage (Bare — matches the app runtime exactly):
 *   node_modules/.bin/bare scripts/inspect-store.mjs "<app-storage path>"
 * Or under Node (rocksdb-native ships a .node prebuild):
 *   node scripts/inspect-store.mjs "<app-storage path>"
 *
 * Default path is the macOS install location if none is given.
 */
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import b4a from 'b4a'

const DEFAULT_PATH = '/Users/oliver/Library/Application Support/Mirall/app-storage'
const argv = (globalThis.Bare?.argv ?? globalThis.process?.argv ?? [])
const PATH = argv.find((a) => typeof a === 'string' && a.includes('app-storage')) || DEFAULT_PATH
const OVERLAY_NAMESPACE = 'mirall-overlay'

const mb = (n) => (n / 1e6).toFixed(2).padStart(9) + ' MB'
const short = (hex) => (hex ? hex.slice(0, 12) : '—'.padEnd(12))
const jsonBytes = (v) => b4a.byteLength(JSON.stringify(v))

function guessKind(sample) {
  if (!sample || sample.length === 0) return 'empty/unreadable'
  if (sample.some((k) => k === 'displayName' || k === 'publicKey' || k.startsWith('member/'))) return 'profile'
  if (sample.some((k) => k.startsWith('file/'))) return 'catalog'
  if (sample.some((k) => k.startsWith('chunkmap') || k.startsWith('tree:') || k.startsWith('treepath:') || k.startsWith('file:') || k === 'config:sync' || k.startsWith('sync:'))) return 'overlay-file-index'
  if (sample.some((k) => k.startsWith('/'))) return 'hyperdrive-db'
  return 'other-bee'
}

async function sampleKeys(core, limit = 8) {
  const bee = new Hyperbee(core.session(), { keyEncoding: 'utf-8', valueEncoding: 'binary' })
  await bee.ready()
  const keys = []
  try {
    for await (const node of bee.createReadStream({ limit }, { wait: false })) {
      keys.push(node.key)
      if (keys.length >= limit) break
    }
  } finally {
    await bee.close()
  }
  return keys
}

async function main() {
  console.log('# Mirall store inspection')
  console.log('path:', PATH)
  console.log('runtime:', globalThis.Bare ? 'bare ' + Bare.version : 'node ' + globalThis.process?.version)
  console.log('')

  const store = new Corestore(PATH)
  await store.ready()

  // ── 1. Enumerate every core by discovery key ──────────────────────────────
  const cores = []
  for await (const dk of store.list()) {
    const dkHex = b4a.toString(dk, 'hex')
    const core = store.get({ discoveryKey: dk })
    try {
      await core.ready()
      let sample = null
      let kind = 'binary/encrypted/non-bee'
      try { sample = await sampleKeys(core); kind = guessKind(sample) } catch { /* not a readable bee */ }
      cores.push({ dkHex, keyHex: core.key ? b4a.toString(core.key, 'hex') : null, byteLength: core.byteLength, length: core.length, kind, sample })
    } catch (err) {
      cores.push({ dkHex, byteLength: 0, length: 0, kind: 'open-failed: ' + err.message })
    }
  }

  cores.sort((a, b) => b.byteLength - a.byteLength)
  const total = cores.reduce((n, c) => n + (c.byteLength || 0), 0)

  console.log('## Cores by size (logical byteLength)')
  console.log('count:', cores.length, ' total:', mb(total))
  console.log('')
  console.log('  #  ' + 'byteLength'.padStart(12) + '  ' + 'blocks'.padStart(8) + '  discoveryKey  kind')
  cores.forEach((c, i) => {
    console.log(
      String(i).padStart(3) + '  ' + mb(c.byteLength) + '  ' + String(c.length).padStart(8) +
      '  ' + short(c.dkHex) + '  ' + c.kind +
      (c.sample && c.sample.length ? '   keys[' + c.sample.slice(0, 4).map((k) => k.length > 28 ? k.slice(0, 28) + '…' : k).join(', ') + ']' : ''),
    )
  })
  console.log('')

  // ── 2. Deep-dive the overlay file-index bee ───────────────────────────────
  // Prefer opening by the app's exact namespace+name; fall back to whichever
  // enumerated core classified as the overlay file-index.
  let fiCore = null
  {
    const ns = store.namespace(OVERLAY_NAMESPACE)
    const c = ns.get({ name: 'file-index', valueEncoding: 'binary' })
    try {
      await c.ready()
      if (c.length > 0) fiCore = c
      else await c.close()
    } catch {
      // Derived key has no stored core (STORAGE_EMPTY) — the live file-index is
      // gone / re-derived; its data may be orphaned in the blob files instead.
      try { await c.close() } catch { /* ignore */ }
    }
  }
  if (!fiCore) {
    const hit = cores.find((c) => c.kind === 'overlay-file-index')
    if (hit) { fiCore = store.get({ discoveryKey: b4a.from(hit.dkHex, 'hex') }); await fiCore.ready() }
  }

  if (!fiCore) {
    console.log('## Overlay file-index: NOT FOUND (no core classified as overlay-file-index)')
  } else {
    console.log('## Overlay file-index deep-dive')
    console.log('discoveryKey:', short(b4a.toString(fiCore.discoveryKey, 'hex')), ' byteLength:', mb(fiCore.byteLength), ' blocks:', fiCore.length)
    console.log('')

    const bee = new Hyperbee(fiCore.session(), { keyEncoding: 'utf-8', valueEncoding: 'binary' })
    await bee.ready()

    const prefixes = ['chunkmap-oid:', 'chunkmap:', 'tree:', 'treepath:', 'file:', 'sync:', 'config:']
    const buckets = new Map(prefixes.map((p) => [p, { count: 0, valueBytes: 0 }]))
    const other = { count: 0, valueBytes: 0 }
    // per shared entity (base key, pages folded in) → total value bytes + page count
    const perBase = new Map() // baseKey → { valueBytes, pages, kind }

    for await (const node of bee.createReadStream({ wait: false })) {
      const key = node.key
      const vlen = node.value ? node.value.byteLength : 0
      const p = prefixes.find((pp) => key.startsWith(pp))
      if (p) { const b = buckets.get(p); b.count++; b.valueBytes += vlen } else { other.count++; other.valueBytes += vlen }

      // Fold chunk-map pages (`<base>\x00<i>`) back into their base key for per-file totals.
      if (key.startsWith('chunkmap:') || key.startsWith('chunkmap-oid:')) {
        const nul = key.indexOf('\x00')
        const base = nul === -1 ? key : key.slice(0, nul)
        const rec = perBase.get(base) || { valueBytes: 0, pages: 0, kind: base.startsWith('chunkmap-oid:') ? 'oid' : 'path' }
        rec.valueBytes += vlen
        if (nul !== -1) rec.pages++
        perBase.set(base, rec)
      }
    }

    console.log('  key-prefix         count       value bytes')
    for (const [p, b] of buckets) console.log('  ' + p.padEnd(16) + String(b.count).padStart(7) + '   ' + mb(b.valueBytes))
    console.log('  ' + '(other)'.padEnd(16) + String(other.count).padStart(7) + '   ' + mb(other.valueBytes))
    const beeValueTotal = [...buckets.values()].reduce((n, b) => n + b.valueBytes, 0) + other.valueBytes
    console.log('  ' + 'TOTAL value bytes'.padEnd(16) + '        ' + mb(beeValueTotal))
    console.log('')

    const top = [...perBase.entries()]
      .map(([base, r]) => ({ base, ...r }))
      .sort((a, b) => b.valueBytes - a.valueBytes)
      .slice(0, 25)
    console.log('## Largest chunk maps (per file / per content-hash), top 25')
    console.log('        value bytes   pages  key')
    for (const r of top) {
      const label = r.base.length > 70 ? r.base.slice(0, 70) + '…' : r.base
      console.log('  ' + mb(r.valueBytes) + '   ' + String(r.pages).padStart(5) + '  ' + label)
    }
    console.log('')
    console.log('chunk-map base keys total:', perBase.size)

    await bee.close()
  }

  try { await store.close() } catch { /* dangling derived session — ignore */ }
  console.log('\n# done')
}

main().catch((err) => { console.error('FATAL:', err.stack || err.message); if (globalThis.Bare) Bare.exit(1); else process.exit(1) })
