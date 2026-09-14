import test from 'brittle'
import { ESLint } from 'eslint'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

// In this codebase `crypto` names hypercore-crypto — a different API from the WebCrypto object
// Node and Bare both expose under the same global. With the global left on, a module that loses
// its import still passes every static gate and fails at the first call, which is a runtime crash
// in a process no unit test loads. Turning the global off makes the missing import an error.
async function lint(filePath, source) {
  const eslint = new ESLint({ cwd: root })
  const [result] = await eslint.lintText(source, { filePath })
  return result.messages.filter((m) => m.ruleId === 'no-undef').map((m) => m.message)
}

test('an unimported crypto is an error in the data layer', async (t) => {
  const undef = await lint(path.join(root, 'src/shared/spaces/fixture-check.js'),
    "export const id = () => crypto.randomBytes(16)\n")
  t.alike(undef, ["'crypto' is not defined."], 'the worker/shared block requires the import')
})

test('an unimported crypto is an error in the main process', async (t) => {
  const undef = await lint(path.join(root, 'src/main/fixture-check.js'),
    "const digest = (v) => crypto.createHash('sha256').update(v).digest('hex')\nmodule.exports = { digest }\n")
  t.alike(undef, ["'crypto' is not defined."], 'the main block requires it too')
})

test('an imported crypto is legal', async (t) => {
  const undef = await lint(path.join(root, 'src/shared/spaces/fixture-check.js'),
    "import crypto from 'hypercore-crypto'\nexport const id = () => crypto.randomBytes(16)\n")
  t.alike(undef, [], 'the explicit import is what every consumer already writes')
})
