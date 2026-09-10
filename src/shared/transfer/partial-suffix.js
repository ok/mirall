// THE in-flight download suffix; the vendored engine receives it as the `partialSuffix` opt, and
// every app-side consumer (collision probes, boot sweep, discard, ignore globs) reads it here.
// Not a bare `.part`: the boot sweep unlinks unreferenced matches in Downloads, where Firefox/KDE
// also write `<name>.part` — `.mirall.part` is proof of ownership. Zero imports: `folders/
// path-keys.js` derives its ignore glob from it and must load under plain Node.
export const PARTIAL_SUFFIX = '.mirall.part'

// Appending matches the engine's `path.join(dirname(t), basename(t) + suffix)` and the
// `finalPath + PARTIAL_SUFFIX` keys the boot sweep builds.
export const partialPathFor = (targetPath) => targetPath + PARTIAL_SUFFIX
