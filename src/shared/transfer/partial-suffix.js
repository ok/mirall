// THE suffix for an in-flight download, and the only place it is defined. The
// overlay engine is vendored, so it cannot import this — the value is threaded in
// as a `partialSuffix` constructor opt. Every app-side consumer (collision probes,
// boot sweep, discard, ignore globs) reads it here.
//
// The token is deliberately not a bare `.part`: the boot sweep unlinks every match
// in the user's Downloads folder that it cannot attribute to a pending row or a
// resume journal, and Firefox/KDE name their in-progress downloads `<name>.part`
// in that same folder. `.mirall.part` is proof of ownership.
//
// Like `folders/path-keys.js`, this module imports NOTHING — `path-keys.js` derives
// its ignore glob from it and must stay loadable under plain Node, where `bare-*`
// does not resolve.
export const PARTIAL_SUFFIX = '.mirall.part'

// `<targetPath>` is always a normalized file path, so appending is exactly what the
// engine's `path.join(dirname(t), basename(t) + suffix)` produces — and it matches
// the `finalPath + PARTIAL_SUFFIX` keys the boot sweep already builds.
export const partialPathFor = (targetPath) => targetPath + PARTIAL_SUFFIX
