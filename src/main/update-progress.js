// How far an update download has come, counted by the app in blocks. The blocks the update's files
// for this platform reference are walked once, at the start, and the ones not on this device are
// the download; each one that arrives counts towards it. The fraction is null until that walk has
// ended, and a download resumed with part of the update already here runs from 0 to 1 over the
// rest. The count does not depend on how the files were written: a file behind a block map names
// its data blocks in the map, any other file is its own block range.
//
// No Electron here, so a Node test drives it against a real updater.

async function referencedBlocks(checkout, blobs, prefix, visit) {
  const entries = [await checkout.entry(prefix)]
  for await (const entry of checkout.list(prefix)) entries.push(entry)
  for (const entry of entries) {
    const blob = entry?.value?.blob
    if (!blob) continue
    for (let i = blob.blockOffset; i < blob.blockOffset + blob.blockLength; i++) await visit(i)
    if (!blob.blockMap) continue
    for (const block of (await blobs.getBlockMap(blob)).blocks) await visit(block.index)
  }
}

// `checkout` is the updater's checkout of the version being downloaded, handed over before the
// mirror starts, so every block the mirror fetches arrives after the listener is on.
function trackUpdateDownload(checkout, prefix) {
  const arrived = new Set()
  let missing = null
  let done = 0
  let core = null
  let stopped = false

  const ondownload = (index) => {
    arrived.add(index)
    if (missing?.has(index)) done++
  }

  async function size() {
    const blobs = await checkout.getBlobs()
    if (stopped) return null
    core = blobs.core
    core.on('download', ondownload)
    const found = new Set()
    // A block that arrived during the walk was missing when the download started.
    await referencedBlocks(checkout, blobs, prefix, async (index) => {
      if (arrived.has(index) || !(await core.has(index))) found.add(index)
    })
    for (const index of arrived) if (found.has(index)) done++
    missing = found
    return found.size
  }

  const sized = size().catch((err) => {
    if (!stopped) console.error('update download could not be sized:', err)
    return null
  })

  return {
    fraction() {
      if (missing === null) return null
      return missing.size === 0 ? 1 : done / missing.size
    },
    stop() {
      stopped = true
      if (core) core.off('download', ondownload)
    },
    // test seam: resolves with the number of blocks to fetch when the walk has ended.
    sized,
  }
}

module.exports = { trackUpdateDownload }
