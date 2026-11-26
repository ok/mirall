import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { parse } from 'yaml'
import { REQUIRED_WORKFLOWS } from '../../scripts/ci/require-green-tests.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const RELEASE_WORKFLOW = path.join(ROOT, '.github/workflows/build-electron.yml')
const APPIMAGE_SCRIPT = path.join(ROOT, 'scripts/build/build-app-image.sh')
const BUILD_SCRIPTS = path.join(ROOT, 'scripts/build')
const FETCH_HELPER = path.join(BUILD_SCRIPTS, 'lib/fetch-verified.sh')

const walk = (dir) => readdirSync(dir).flatMap((entry) => {
  const full = path.join(dir, entry)
  return statSync(full).isDirectory() ? walk(full) : [full]
})

const ciFiles = walk(path.join(ROOT, '.github')).filter((file) => /\.ya?ml$/.test(file))

const workflow = parse(readFileSync(RELEASE_WORKFLOW, 'utf8'))
const steps = Object.entries(workflow.jobs).flatMap(([job, { steps: jobSteps = [] }]) =>
  jobSteps.map((step) => ({ job, ...step })))
const stepNamed = (name) => steps.find((step) => step.name === name || step.id === name)
const stepOrder = (job) => steps.filter((step) => step.job === job).map((step) => step.name ?? step.id)

test('REGRESSION (MIR-56: the release workflow token cannot write the repo)', (t) => {
  t.alike(workflow.permissions, { contents: 'read' })
  const widened = Object.entries(workflow.jobs)
    .filter(([, job]) => Object.values(job.permissions ?? {}).includes('write'))
    .map(([name]) => name)
  t.alike(widened, [], 'no job widens the token')
})

test('REGRESSION (MIR-56: a prod build cannot be dispatched from any ref)', (t) => {
  t.alike(workflow.on.workflow_dispatch.inputs.channel.options, ['dev', 'staging'])
  const channel = stepNamed('ch')?.run ?? ''
  t.ok(/"\$EVENT" = "push" \] && \[ "\$GITHUB_REF_TYPE" = "tag" \]/.test(channel), 'prod is chosen only for a tag push')
  t.ok(/dev\|staging\) CHANNEL="\$INPUT_CHANNEL"/.test(channel), 'a dispatch accepts only dev and staging')
  t.absent(/V="\$BASE"\s*$/m.test(stepNamed('ver')?.run ?? ''), 'no version is taken bare from package.json')
})

test('REGRESSION (MIR-56: the build job runs in the environment its channel selects)', (t) => {
  t.is(workflow.jobs.build.environment, "${{ needs.resolve.outputs.channel == 'prod' && 'release' || 'beta' }}")
})

test('a tag build checks the tag format and that the tag sits on its release branch', (t) => {
  const gate = stepNamed('Verify tag format and release branch')
  t.ok(gate, 'the gate exists')
  t.is(gate?.if, "github.ref_type == 'tag'")
  t.ok(gate?.run.includes('merge-base --is-ancestor "$GITHUB_SHA" "origin/release/$LINE"'), 'ancestry is checked')
  const order = stepOrder('resolve')
  t.ok(order.indexOf('Verify tag format and release branch') < order.indexOf('ver'), 'the gate runs before the tag is read as a version')
})

test('a prod or staging build is refused before the build job unless the commit has a green test run', (t) => {
  const gate = stepNamed('Require a green Test run for this commit')
  t.ok(gate, 'the gate exists')
  t.is(gate?.job, 'resolve')
  t.is(gate?.if, "steps.ch.outputs.channel != 'dev'", 'only a dev build is exempt, and no input skips it')
  t.is(gate?.run, 'node scripts/ci/require-green-tests.mjs')
  t.alike(gate?.env, { GITHUB_TOKEN: '${{ github.token }}' })
  t.absent(gate?.['continue-on-error'], 'a refusal fails the job')

  const order = stepOrder('resolve')
  const checkout = workflow.jobs.resolve.steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'))
  t.ok(checkout >= 0 && checkout < order.indexOf('Require a green Test run for this commit'), 'the script is checked out first')
  t.ok(order.indexOf('ch') < order.indexOf('Require a green Test run for this commit'), 'the channel is known first')

  const needs = [workflow.jobs.build.needs].flat()
  t.ok(needs.includes('resolve'), 'the build job, and its environment approval, wait for resolve')
  t.alike(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), ['channel', 'platform'], 'no override input')

  t.alike(workflow.jobs.resolve.permissions, { contents: 'read', actions: 'read' }, 'resolve may read workflow runs')
  const others = Object.entries(workflow.jobs).filter(([name, job]) => name !== 'resolve' && job.permissions)
  t.alike(others.map(([name]) => name), [], 'no other job changes the token')
})

// A commit can only pass the gate if each required workflow runs where release commits land, and a
// commit left without a run can be given one.
test('every workflow a release requires runs on trunk and release pushes and can be dispatched', (t) => {
  t.ok(REQUIRED_WORKFLOWS.length > 0)
  for (const file of REQUIRED_WORKFLOWS) {
    const required = parse(readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8'))
    t.alike(required.on.push?.branches, ['main', 'release/**'], `${file} runs on pushes to main and release branches`)
    t.absent(required.on.push?.paths || required.on.push?.['paths-ignore'], `${file} skips no push by path`)
    t.ok('workflow_dispatch' in required.on, `${file} can be dispatched`)
    t.absent(required.concurrency, `${file} never cancels a run for a newer one`)
  }
})

test('REGRESSION (MIR-56: no expression is pasted into a release shell script)', (t) => {
  const pasted = steps
    .filter((step) => step.run && /\$\{\{/.test(step.run))
    .map((step) => `${step.job}: ${step.name ?? step.id}`)
  t.alike(pasted, [], 'values reach run: blocks through env:')
})

test('REGRESSION (MIR-56: a released artifact path is written once)', (t) => {
  const upload = stepNamed('Upload to R2')?.run ?? ''
  t.ok(/aws s3api put-object [^\n]*--if-none-match '\*'/.test(upload), 'the prod upload is a conditional PUT')
  t.absent(/\bcurl\b/.test(upload), 'no tool is downloaded during the upload')
  t.absent(/skipping upload/.test(upload), 'missing credentials are not a silent skip')
})

test('a build in an environment missing a secret fails before it installs anything', (t) => {
  t.ok(stepNamed('Require release credentials'), 'the credentials step exists')
  const order = stepOrder('build')
  t.ok(order.indexOf('Require release credentials') < order.indexOf('Install dependencies'))
})

test('the release checkouts leave no token in .git/config', (t) => {
  const checkouts = steps.filter((step) => step.uses?.startsWith('actions/checkout@'))
  t.ok(checkouts.length >= 2, 'both jobs check out')
  for (const checkout of checkouts) t.is(checkout.with?.['persist-credentials'], false, `${checkout.job} checkout`)
})

// The YAML parser drops comments, so the pin and its version comment are read as lines.
const PINNED_USE = /^\s*(?:-\s+)?uses:\s+(?:\.\/\S+|[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s+v\S+)\s*$/

test('REGRESSION (MIR-56: every action is pinned to a commit)', (t) => {
  const loose = []
  for (const file of ciFiles) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (/^\s*(?:-\s+)?uses:/.test(line) && !PINNED_USE.test(line)) {
        loose.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`)
      }
    })
  }
  t.alike(loose, [])
})

const appImage = readFileSync(APPIMAGE_SCRIPT, 'utf8')

test('REGRESSION (MIR-55: the AppImage runtime is hash-pinned before and after it is patched)', (t) => {
  t.is([...appImage.matchAll(/URUNTIME_SHA256="[0-9a-f]{64}"/g)].length, 2, 'a raw pin per arch')
  t.is([...appImage.matchAll(/URUNTIME_PATCHED_SHA256="[0-9a-f]{64}"/g)].length, 2, 'a patched pin per arch')
  const fetch = appImage.indexOf('fetch_verified "https://github.com/VHSgunzo/uruntime/')
  const patch = appImage.indexOf("sed -i 's|URUNTIME_MOUNT=")
  const recheck = appImage.indexOf('verify_sha256 "$URUNTIME" "$URUNTIME_PATCHED_SHA256"')
  t.ok(fetch > 0 && fetch < patch && patch < recheck, 'fetch and verify, then patch, then verify the patched bytes')
  t.absent(/\$\{URUNTIME_VERSION:-/.test(appImage), 'no version override without its hash')
})

test('REGRESSION (MIR-55: the app-builder fallback download is hash-pinned)', (t) => {
  t.ok(/APP_BUILDER_SHA256="[0-9a-f]{64}"/.test(appImage), 'the tarball has a pin')
  t.ok(/fetch_verified "https:\/\/registry\.npmjs\.org\/app-builder-bin\//.test(appImage), 'it is fetched through the helper')
  t.absent(/\$\{APP_BUILDER_VERSION:-/.test(appImage), 'no version override without its hash')
})

test('build scripts download only through the verifying helper', (t) => {
  const offenders = walk(BUILD_SCRIPTS)
    .filter((file) => file.endsWith('.sh') && file !== FETCH_HELPER)
    .filter((file) => /\b(?:curl|wget)\b/.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file))
  t.alike(offenders, [])
})
