// Helpers both spike drivers (Node) and both bare scripts share. Pure: no runtime import.

// `--name value`; a missing or flag-shaped value yields the default rather than NaN downstream.
export function flag(args, name, dflt) {
  const i = args.indexOf(name)
  if (i === -1) return dflt
  const value = args[i + 1]
  return value === undefined || value.startsWith('--') ? dflt : value
}

export const line = (obj) => console.log(JSON.stringify({ t: Date.now(), ...obj }))

export const errorCode = (err) => err.code || err.message

// The .bin shim is a Node wrapper that neither forwards a signal nor reports the real pid, so the
// drivers spawn the platform binary itself.
export const bareBinaryRelative = (platform, arch) =>
  `../../node_modules/bare-runtime-${platform}-${arch}/bin/bare${platform === 'win32' ? '.exe' : ''}`

export function vmRssKb(statusText) {
  const m = /VmRSS:\s+(\d+)/.exec(statusText)
  return m ? Number(m[1]) : null
}
