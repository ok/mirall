// The fetch diag exposes no readable state, so its log lines are the artifact a test reads. Given
// lines captured at the verbose level (capture-console.js, ['log', 'warn']), this keeps the diag's
// own lines for one file minus its opening ones: what is left is how it closed.
export function diagEnds(lines, relPath) {
  return [...lines.log, ...lines.warn]
    .filter((l) => l.startsWith('[overlay-fetch]') && l.includes(relPath))
    .filter((l) => !/ start: | scheduler end: /.test(l))
}
