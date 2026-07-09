// Anonymous per-install identifier: a random UUID minted once and persisted as
// `install-id` in app storage (atomic tmp+rename write). Unrelated to any identity
// key — it only lets the feedback relay group reports from the same install.
import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

let cached = null

function uuidv4 () {
  const b = crypto.randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = b4a.toString(b, 'hex')
  return (
    hex.slice(0, 8) + '-' +
    hex.slice(8, 12) + '-' +
    hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' +
    hex.slice(20, 32)
  )
}

export async function getInstallId (storagePath) {
  if (cached) return cached
  const file = path.join(storagePath, 'install-id')
  try {
    const buf = await fs.promises.readFile(file)
    const id = b4a.toString(buf, 'utf-8').trim()
    if (id) {
      cached = id
      return cached
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  const id = uuidv4()
  const tmp = file + '.tmp'
  await fs.promises.writeFile(tmp, id, { encoding: 'utf-8', mode: 0o600 })
  await fs.promises.rename(tmp, file)
  cached = id
  return cached
}
