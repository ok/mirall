// The organization's backup folder template (the Console's packages/core/configuration/
// path-template.ts): what a template may be, and how a device turns it into its own folder. The
// Console's path-template-v1.json pins both halves.
const MAX_TEMPLATE_CHARS = 400
const MAX_FOLDER_CHARS = 255
const MAX_VALUE_CHARS = 64
const INSTALL_HEX = 12

const SEPARATOR = { windows: '\\', macos: '/', linux: '/' }
const ALL_PLACEHOLDERS = /\{(user|host|install)\}/g
const HAS_PLACEHOLDER = /\{(user|host|install)\}/
const NAMED_BRACE = /\{[A-Za-z]+\}/
const BRACE = /[{}]/
const WINDOWS_FORBIDDEN = /[<>:"/\\|?*]/
const DRIVE = /^[A-Za-z]:\\/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
const PLACEHOLDER_WIDTH = { user: MAX_VALUE_CHARS, host: MAX_VALUE_CHARS, install: INSTALL_HEX }
const SPELLED = { 'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O', 'œ': 'oe', 'Œ': 'OE', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D' }

const isControl = (char) => {
  const code = char.charCodeAt(0)
  return code < 0x20 || code === 0x7f
}

function textProblem(platform, input) {
  if (input.length === 0) return 'empty'
  if (input.length > MAX_TEMPLATE_CHARS) return 'too_long'
  const separator = SEPARATOR[platform]
  if (input.includes(separator === '/' ? '\\' : '/')) return 'wrong_separator'
  if (input.endsWith(separator)) return 'trailing_separator'
  if ([...input].some(isControl)) return 'bad_character'
  return null
}

function placeholderProblem(input) {
  const unplaced = input.replace(ALL_PLACEHOLDERS, '\u0000')
  if (BRACE.test(unplaced)) return NAMED_BRACE.test(unplaced) ? 'unknown_placeholder' : 'stray_brace'
  const installs = input.split('{install}').length - 1
  if (installs === 0) return 'install_missing'
  if (installs > 1) return 'install_repeated'
  return null
}

function segmentProblem(platform, segment) {
  if (segment === '') return 'empty_segment'
  if (segment === '.' || segment === '..') return 'dot_segment'
  const widest = segment.replace(ALL_PLACEHOLDERS, (_, name) => 'x'.repeat(PLACEHOLDER_WIDTH[name])).length
  if (widest > MAX_FOLDER_CHARS) return 'folder_too_long'
  if (platform !== 'windows') return null
  if (WINDOWS_FORBIDDEN.test(segment.replace(ALL_PLACEHOLDERS, ''))) return 'bad_character'
  if (segment.endsWith(' ') || segment.endsWith('.')) return 'bad_folder_end'
  if (!HAS_PLACEHOLDER.test(segment) && WINDOWS_RESERVED.test(segment)) return 'reserved_name'
  return null
}

function splitRoot(platform, input) {
  if (platform !== 'windows') {
    if (!input.startsWith('/')) return 'not_absolute'
    return { root: '/', share: [], rest: input.slice(1).split('/') }
  }
  if (input.startsWith('\\\\')) {
    const [server = '', share = '', ...rest] = input.slice(2).split('\\')
    if (BRACE.test(server) || BRACE.test(share)) return 'placeholder_in_share'
    return { root: '\\\\', share: [server, share], rest }
  }
  if (DRIVE.test(input)) return { root: input.slice(0, 3), share: [], rest: input.slice(3).split('\\') }
  return 'not_absolute'
}

// The template split at its base (the literal prefix that must exist on the device), or the name of
// the first rule it breaks.
export function parseTemplate(platform, input) {
  const problem = textProblem(platform, input) ?? placeholderProblem(input)
  if (problem) return problem
  const split = splitRoot(platform, input)
  if (typeof split === 'string') return split
  const { root, share, rest } = split
  const segment = [...share, ...rest].map((part) => segmentProblem(platform, part)).find((found) => found !== null)
  if (segment) return segment
  const first = rest.findIndex((part) => HAS_PLACEHOLDER.test(part))
  const literal = rest.slice(0, first)
  if (share.length === 0 && literal.length === 0) return 'base_too_short'
  return { platform, base: root + [...share, ...literal].join(SEPARATOR[platform]), segments: rest.slice(first) }
}

export function sanitiseSegment(raw, fallback) {
  const cleaned = raw.normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^ -~]/g, (char) => SPELLED[char] ?? '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/_+/g, '_')
    .slice(0, MAX_VALUE_CHARS - 1)
    .replace(/^[._]+|[._]+$/g, '')
  if (cleaned === '') return fallback
  return cleaned.replace(WINDOWS_RESERVED, (match, name) => `${name}_${match.slice(name.length)}`)
}

// The device's folder: the base, the full path, and the folders below the base to create, outermost
// first. 'invalid_install_id' when the installId is not a UUID.
export function resolveTemplate(parsed, facts) {
  if (!UUID.test(facts.installId)) return 'invalid_install_id'
  const separator = SEPARATOR[parsed.platform]
  const values = {
    user: sanitiseSegment(facts.username, 'user'),
    host: sanitiseSegment(facts.hostname.replace(/\.local$/i, ''), 'device'),
    install: facts.installId.replace(/-/g, '').toLowerCase().slice(0, INSTALL_HEX),
  }
  const create = []
  let path = parsed.base
  for (const segment of parsed.segments) {
    path = `${path}${separator}${segment.replace(ALL_PLACEHOLDERS, (_, name) => values[name])}`
    create.push(path)
  }
  return { base: parsed.base, path, create }
}
