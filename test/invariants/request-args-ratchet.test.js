import test from 'brittle'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const REQUESTS = path.resolve(here, '../../src/shared/contract/requests.js')

// Optional is the exception that needs a reason, so the count only goes down. Raising it means a
// new field whose absence the handler genuinely defines — and the header comment is where that
// reason is written, not here.
//
// Read as text rather than imported, per this folder's rule: a guard scans src/** and imports
// nothing from it, so the contract cannot make its own rule pass by changing what it exports.
const OPTIONAL_CEILING = 46

test('optional request fields do not grow', (t) => {
  const src = readFileSync(REQUESTS, 'utf8')
  const n = (src.match(/optional: true/g) || []).length
  t.ok(n <= OPTIONAL_CEILING,
    `${n} optional field(s), ceiling ${OPTIONAL_CEILING} — a new one needs its absence defined by a handler`)
})

// The other half: the bound the boundary applies has to come from the shared table, not from a
// number somebody typed at the call site.
test('every length bound comes from ARG_MAX', (t) => {
  const src = readFileSync(REQUESTS, 'utf8')
  const literals = [...src.matchAll(/max:\s*(\d+)/g)].map((m) => m[0])
  t.alike(literals, [], 'a bare number here is a limit with no owner — use ARG_MAX')
  t.ok((src.match(/max: ARG_MAX\./g) || []).length > 0, 'and the table is actually used')
})
