// A backup repository in a folder: a local disk, an external drive, or a network share. A file is
// written whole under a temporary name, synced, checked for size, and only then given its final name —
// by a hard link, which fails rather than replacing a file already there, or, on a share that has no
// hard links, by a rename after checking the name is free. A failed write leaves a stray temporary
// file and nothing under a final name. The folder the user chose is never created here: a share that
// is not mounted must read as offline, not as an empty folder on the local disk.
import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'
import { AppError, classifyLocalIoFault, isLocalDestFault } from '../../core/errors.js'
import { CODES } from '../../contract/errors.js'

export const REPO_DIR = 'Mirall Backup'
const TMP = 'tmp'
const STALE_TMP_MS = 60 * 60 * 1000
const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'])

export function classifyTargetError(err) {
  if (err instanceof AppError) return err
  const why = `backup folder: ${err?.code || ''} ${err?.message || err}`.trim()
  const fault = classifyLocalIoFault(err)
  if (fault === CODES.TRANSFER_DISK_FULL) return new AppError(CODES.BACKUP_TARGET_FULL, why)
  if (fault === CODES.TRANSFER_PERMISSION) return new AppError(CODES.BACKUP_TARGET_DENIED, why)
  if (isLocalDestFault(err?.code)) return new AppError(CODES.BACKUP_TARGET_OFFLINE, why)
  return err
}

async function guard(fn) {
  try {
    return await fn()
  } catch (err) {
    throw classifyTargetError(err)
  }
}

async function exists(file) {
  try {
    await fs.promises.stat(file)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

// One level at a time below `base`: a recursive mkdir reports a permission refusal as ENOENT, which
// would read a folder Mirall may not write to as one that is not there.
async function makeDirs(base, rel) {
  let dir = base
  for (const part of rel.split('/').filter(Boolean)) {
    dir = path.join(dir, part)
    try {
      await fs.promises.mkdir(dir)
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
  }
}

// A write may land short without an error (a full drive, a share): it loops until every byte is in.
async function writeSynced(file, bytes) {
  const handle = await fs.promises.open(file, 'wx', 0o600)
  try {
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset)
      if (bytesWritten <= 0) throw new AppError(CODES.BACKUP_TARGET_FULL, 'backup folder: a write made no progress')
      offset += bytesWritten
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
  const { size } = await fs.promises.stat(file)
  if (size !== bytes.byteLength) throw new AppError(CODES.BACKUP_TARGET_FULL, `backup folder: wrote ${size} of ${bytes.byteLength} bytes`)
}

// 'written', or 'exists' when the name was already taken — never replacing what is there.
async function claim(tmp, final) {
  try {
    await fs.promises.link(tmp, final)
    return 'written'
  } catch (err) {
    if (err.code === 'EEXIST') return 'exists'
    if (!NO_HARD_LINKS.has(err.code)) throw err
  }
  if (await exists(final)) return 'exists'
  await fs.promises.rename(tmp, final)
  return 'written'
}

export class FolderTarget {
  constructor(chosenFolder) {
    this.chosen = chosenFolder
    this.dir = path.join(chosenFolder, REPO_DIR)
  }

  _tmpFile() {
    return path.join(this.dir, TMP, b4a.toString(crypto.randomBytes(16), 'hex'))
  }

  // The chosen folder must already exist; the repository folder inside it is created only when
  // asked, which is the first setup. Temporary files a stopped run left behind are cleared.
  async ready({ create = false, now = Date.now() } = {}) {
    await guard(async () => {
      if (!(await fs.promises.stat(this.chosen)).isDirectory()) throw new AppError(CODES.BACKUP_TARGET_OFFLINE, 'backup folder: not a folder')
      if (!create && !(await exists(this.dir))) throw new AppError(CODES.BACKUP_TARGET_OFFLINE, 'backup folder: no backup in this folder')
      await makeDirs(this.chosen, `${REPO_DIR}/${TMP}`)
      for (const name of await fs.promises.readdir(path.join(this.dir, TMP))) {
        const file = path.join(this.dir, TMP, name)
        const { mtimeMs } = await fs.promises.stat(file)
        if (now - mtimeMs > STALE_TMP_MS) await fs.promises.rm(file, { force: true })
      }
    })
  }

  has(rel) {
    return guard(() => exists(path.join(this.dir, rel)))
  }

  read(rel) {
    return guard(() => fs.promises.readFile(path.join(this.dir, rel)))
  }

  list(relDir) {
    return guard(async () => {
      try {
        return await fs.promises.readdir(path.join(this.dir, relDir))
      } catch (err) {
        if (err.code === 'ENOENT') return []
        throw err
      }
    })
  }

  putOnce(rel, bytes) {
    return guard(async () => {
      const final = path.join(this.dir, rel)
      if (await exists(final)) return 'exists'
      const tmp = this._tmpFile()
      try {
        await writeSynced(tmp, bytes)
        await makeDirs(this.dir, path.dirname(rel))
        return await claim(tmp, final)
      } finally {
        await fs.promises.rm(tmp, { force: true })
      }
    })
  }

  // A file only this device ever writes. Removed, then replaced: a crash in between leaves it absent,
  // which reads as "this device has not written yet", never as a torn file.
  replaceOwn(rel, bytes) {
    return guard(async () => {
      const final = path.join(this.dir, rel)
      const tmp = this._tmpFile()
      await writeSynced(tmp, bytes)
      await makeDirs(this.dir, path.dirname(rel))
      await fs.promises.rm(final, { force: true })
      await fs.promises.rename(tmp, final)
    })
  }
}
