// The meta line under a share card's name: "N files · size · <owner>" once the
// folder info is known, or just the owner line while counts are still loading.
// The owner line is one choice — "Shared by you" for your own share, "Owned by
// {name}" for anyone else's — never one label nested inside the other.
export function shareSizeLine ({ isYou, ownerName, fileCount, size }, t) {
  const ownerLine = isYou ? t('share.sharedByYou') : t('share.ownedBy', { name: ownerName ?? '?' })
  if (fileCount == null) return ownerLine
  return `${t('share.fileCountAndSize', { count: fileCount, size })} · ${ownerLine}`
}
