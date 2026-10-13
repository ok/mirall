// The name people read for a folder share. `share:rename` writes `displayName` and leaves `name`
// alone, because `name` keys every member's drive paths. Pure, so test/unit and the peer observer
// can load it.

/**
 * @param {{ name?: string | null, displayName?: string | null } | null | undefined} share
 * @returns {string | null}
 */
export const shareLabel = (share) => share?.displayName || share?.name || null
