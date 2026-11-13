// The install's instance key: random, made at Accept, deleted on Leave, and machine-only. It names
// this computer, not the person, so it is not sealed under the identity and never moves with it. The
// license it enrolled with, the report counter and whether the license was revoked live beside it; a
// file that does not parse is treated as absent, and a new key is made.
import fs from 'bare-fs'
import path from 'bare-path'
import { SECRET_FILE, resolveSecretFile } from '../contract/secret-files.js'
import { writeFileAtomic } from '../core/atomic-file.js'

const VERSION = 1
const HEX32 = /^[0-9a-f]{64}$/

const instanceFile = (storagePath) => resolveSecretFile(storagePath, SECRET_FILE.INSTANCE, { join: path.join, dirname: path.dirname, exists: fs.existsSync })
const writeTarget = (storagePath) => path.join(path.dirname(storagePath), SECRET_FILE.INSTANCE)

const valid = (v) => v?.v === VERSION && HEX32.test(v.seed) && HEX32.test(v.enrollPublicKey) &&
  Number.isSafeInteger(v.counter) && v.counter >= 0 && typeof v.enrolled === 'boolean'

export function readInstanceKey(storagePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(instanceFile(storagePath), 'utf8'))
    return valid(parsed) ? { seed: parsed.seed, enrollPublicKey: parsed.enrollPublicKey, counter: parsed.counter, enrolled: parsed.enrolled, revoked: parsed.revoked === true } : null
  } catch {
    return null
  }
}

export async function writeInstanceKey(storagePath, { seed, enrollPublicKey, counter, enrolled, revoked }) {
  const inside = path.join(storagePath, SECRET_FILE.INSTANCE)
  await writeFileAtomic(fs.existsSync(inside) ? inside : writeTarget(storagePath), JSON.stringify({ v: VERSION, seed, enrollPublicKey, counter, enrolled, revoked }))
}

export async function removeInstanceKey(storagePath) {
  for (const file of [path.join(storagePath, SECRET_FILE.INSTANCE), writeTarget(storagePath)]) {
    await fs.promises.rm(file, { force: true })
  }
}
