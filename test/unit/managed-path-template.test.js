import test from 'brittle'
import vectors from '../fixtures/managed/path-template-v1.json' with { type: 'json' }
import { parseTemplate, resolveTemplate } from '../../src/shared/managed/path-template.js'

test('every valid template parses to its base and resolves for every fact set', (t) => {
  for (const v of vectors.valid) {
    const parsed = parseTemplate(v.platform, v.template)
    t.is(typeof parsed, 'object', v.template)
    t.is(parsed.base, v.base, v.template)
    for (const facts of vectors.facts) {
      const got = resolveTemplate(parsed, facts)
      t.alike({ path: got.path, create: got.create }, v.resolved[facts.name], `${v.template} · ${facts.name}`)
      t.is(got.base, v.base)
    }
    for (const installId of vectors.invalidInstallIds) t.is(resolveTemplate(parsed, { ...vectors.facts[0], installId }), 'invalid_install_id', `${v.template} · ${JSON.stringify(installId)}`)
  }
})

test('every invalid template names the first rule it breaks', (t) => {
  for (const v of vectors.invalid) t.is(parseTemplate(v.platform, v.template), v.problem, `${v.platform} ${JSON.stringify(v.template)}`)
})
