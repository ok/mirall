// What an organization's activation link looks like, without decoding it: main routes
// mirall://license/a/<code> with this, and the worker decodes and checks the code itself. String
// operations only, so it runs unchanged in main, the worker and the renderer.
export const ACTIVATION_SCHEME_HOST = 'license'
export const ACTIVATION_PREFIX = 'a/'
export const MAX_CODE_CHARS = 512
const Z32 = /^[ybndrfg8ejkmcpqxot1uwisza345h769]+$/
const WEB_PATH = /^\/(link\/)?license\/?$/

/**
 * mirall://license/a/<code>, https://<host>/license#a/<code>, https://<host>/link/license#a/<code>
 * or a bare "a/<code>" → the code; anything else → null.
 * @param {unknown} input
 * @returns {string | null}
 */
export function extractActivationCode(input) {
  if (typeof input !== 'string') return null
  const text = input.trim()
  const payload = linkPayload(text)
  if (payload === null || !payload.startsWith(ACTIVATION_PREFIX)) return null
  return payload.slice(ACTIVATION_PREFIX.length).replace(/\/+$/, '') || null
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function linkPayload(text) {
  const lower = text.toLowerCase()
  if (lower.startsWith('mirall://')) {
    const rest = text.slice('mirall://'.length)
    const slash = rest.indexOf('/')
    if (slash < 0 || rest.slice(0, slash).toLowerCase() !== ACTIVATION_SCHEME_HOST) return null
    return rest.slice(slash + 1)
  }
  if (lower.startsWith('https://')) {
    const hash = text.indexOf('#')
    if (hash < 0) return null
    const hostAndPath = text.slice('https://'.length, hash)
    const pathStart = hostAndPath.indexOf('/')
    if (pathStart < 0 || !WEB_PATH.test(hostAndPath.slice(pathStart))) return null
    try {
      return decodeURIComponent(text.slice(hash + 1))
    } catch {
      return null
    }
  }
  return text
}

/**
 * The alphabet and the length only; the checksum is the worker's to check.
 * @param {string} code
 * @returns {boolean}
 */
export function looksLikeActivationCode(code) {
  return code.length > 0 && code.length <= MAX_CODE_CHARS && Z32.test(code.toLowerCase())
}
