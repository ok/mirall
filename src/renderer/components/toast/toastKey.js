// The id a toast gets when its caller names none. Deriving it from the content means the same
// sentence said twice replaces itself rather than stacking a second banner: a user retrying a
// failing action sees one error, not one per attempt. A caller passes an explicit id only when
// DIFFERENT text has to replace what is on screen — the connectivity and download-folder bridges,
// where each transition rewords one persistent fault.
/** @import { ToastVariant } from './types.js' */

/** @param {ToastVariant} variant @param {string} message */
export function toastKey(variant, message) {
  return `auto:${variant}:${message}`
}
