// The in-app toast a terminal transfer fault raises, if any. Keyed per (space, fault): a folder
// download fails every file at once, and one toast stands for all of them, so the copy names no
// file.
import { CODES } from '../../shared/contract/errors.js'

/** @type {ReadonlyMap<string, { key: string, idPrefix: string }>} */
const TOAST_BY_CODE = new Map([
  [CODES.TRANSFER_DISK_FULL, { key: 'file.transferDiskFullToast', idPrefix: 'disk-full' }],
  [CODES.TRANSFER_CHECKSUM, { key: 'file.transferChecksumToast', idPrefix: 'checksum' }],
])

/**
 * @param {string} spaceId
 * @param {string | undefined} errorCode
 * @returns {{ key: string, id: string } | null}
 */
export function transferFaultToast(spaceId, errorCode) {
  const toast = errorCode ? TOAST_BY_CODE.get(errorCode) : undefined
  return toast ? { key: toast.key, id: `${toast.idPrefix}:${spaceId}` } : null
}
