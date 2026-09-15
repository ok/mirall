// The overlay content hash of a file on disk: size-bound and wire-compatible with registerFile and
// the consumer's per-chunk verify. A plain blake2b never matches a catalog contentHash, so every
// comparison against one goes through here. `signal` is polled per chunk so a cancelled publish
// does not hold its slot for the rest of a multi-gigabyte read; rejects with ECANCELLED like
// prepareForServe.
import fs from 'bare-fs'
import { createStreamingHasher } from './vendor/chunker.js'

export async function overlayHashFile(absPath, onProgress, signal) {
  const h = createStreamingHasher({ size: fs.statSync(absPath).size })
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(absPath)
    rs.on('data', (c) => {
      if (signal?.aborted) {
        const err = new Error('hash aborted')
        err.code = 'ECANCELLED'
        rs.destroy(err)
        return
      }
      h.update(c)
      onProgress?.(c.length)
    })
    rs.on('end', resolve)
    rs.on('error', reject)
  })
  return h.digest()
}
