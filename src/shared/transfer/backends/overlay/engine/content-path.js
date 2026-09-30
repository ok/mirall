// The synthetic path a content-addressed serve or fetch travels under on the wire.
const CONTENT_PREFIX = 'content:'

export const contentPath = (contentHash) => CONTENT_PREFIX + contentHash

// The content hash a synthetic path names, or null for any other path.
export const contentHashOf = (path) => (typeof path === 'string' && path.startsWith(CONTENT_PREFIX) ? path.slice(CONTENT_PREFIX.length) : null)
