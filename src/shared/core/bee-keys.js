// The range bound for a Hyperbee prefix scan.
//
// A bee keyed `utf-8` compares keys as UTF-8 bytes, and UTF-8 preserves code-point order. So the
// exclusive upper bound for "every key under `prefix`" is the prefix with its final character
// incremented: whatever the suffix holds, `prefix + suffix` differs from that bound at the final
// character and sorts below it. Appending a high sentinel to the prefix instead only bounds
// suffixes whose first character sorts below the sentinel and silently drops the rest — under
// '\xff' (U+00FF) a share holding `Łódź.pdf` or `日本語.txt` at its top level lists short.
//
// The final character must be ASCII, so incrementing it stays one well-formed code point. Every key
// namespace in the data layer ends its prefix with a separator ('/', ':', '|'), which satisfies that.
export function prefixRange(prefix) {
  const last = typeof prefix === 'string' ? prefix.charCodeAt(prefix.length - 1) : NaN
  if (!(last >= 0x20 && last < 0x7f)) {
    throw new Error('prefixRange needs a prefix ending in an ASCII separator, got ' + JSON.stringify(prefix))
  }
  return { gte: prefix, lt: prefix.slice(0, -1) + String.fromCharCode(last + 1) }
}
