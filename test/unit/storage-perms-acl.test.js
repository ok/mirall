import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import mod from '../../src/main/storage-perms.js'
import { ConfigStore } from '../../src/main/config-store.js'
import { writeRelaySeedHex, seedFile } from '../../src/main/relay-secret.js'
import { scaled } from '../helpers/timing.js'

const { hardenStorageDirs } = mod

// Windows has no file mode, so the 0600 the writers ask for means nothing there: what keeps
// config.json and the vaults from other accounts is the ACL on the user data folder alone. This
// file runs the real whoami and icacls and reads the real ACL back; it needs Windows to do so.
const NOT_WINDOWS = process.platform !== 'win32'

const SYSTEM = 'S-1-5-18'
const BROAD = { 'S-1-1-0': 'Everyone', 'S-1-5-11': 'Authenticated Users', 'S-1-5-32-545': 'Users' }
const FULL_CONTROL = 0x1f01ff
const OBJECT_AND_CONTAINER_INHERIT = 3
const SEED = '9d73b3a76df0938ff055a76e4c096c54cc245b35d4db31b582faba9dde94ae4e'

// Trustees are read as SIDs and rights as numbers: account names and icacls' own output are
// localized. The paths travel in the environment, so no path is ever quoted into the script.
const READ_ACLS = `
$ErrorActionPreference = 'Stop'
$sidType = [System.Security.Principal.SecurityIdentifier]
$acls = @($env:MIRALL_ACL_PATHS -split '\\|' | ForEach-Object {
  $acl = Get-Acl -LiteralPath $_
  $rules = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object {
    [pscustomobject]@{
      sid = $_.IdentityReference.Value
      allow = ($_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow)
      rights = [int]$_.FileSystemRights
      inherited = [bool]$_.IsInherited
      inheritance = [int]$_.InheritanceFlags
      propagation = [int]$_.PropagationFlags
    }
  })
  [pscustomobject]@{ path = $_; protected = [bool]$acl.AreAccessRulesProtected; sddl = $acl.Sddl; rules = $rules }
})
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
[pscustomobject]@{ me = $me; acls = $acls } | ConvertTo-Json -Depth 5 -Compress
`

function readAcls(paths) {
  const stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', READ_ACLS], {
    env: { ...process.env, MIRALL_ACL_PATHS: paths.join('|') },
    encoding: 'utf8',
    windowsHide: true,
  })
  const { me, acls } = JSON.parse(stdout)
  return { me, byPath: new Map(acls.map((acl) => [acl.path, acl])) }
}

const fakeSafeStorage = { encryptString: (value) => Buffer.from('enc:' + value) }
const sids = (acl) => acl.rules.map((rule) => rule.sid).sort()

test('Windows: the real ACL on the user data folder is this account and SYSTEM only, and everything in it inherits that', { skip: NOT_WINDOWS, timeout: scaled(60000) }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-perms-acl-'))
  t.teardown(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const storage = path.join(dataDir, 'app-storage')
  const existingFile = path.join(dataDir, 'identity.enc')
  const nestedFile = path.join(storage, 'cores', 'data')
  fs.mkdirSync(path.dirname(nestedFile), { recursive: true })
  fs.writeFileSync(existingFile, 'x')
  fs.writeFileSync(nestedFile, 'x')

  const before = readAcls([dataDir])
  t.absent(before.byPath.get(dataDir).protected, 'a fresh folder inherits its parent\'s ACL, so the step has something to cut')

  const errors = []
  await hardenStorageDirs(storage, { log: { error: (...args) => errors.push(args.join(' ')) } })
  t.alike(errors, [], 'whoami and icacls ran clean')
  t.ok(fs.existsSync(path.join(dataDir, '.owner-acl-v1')), 'the marker records the applied ACL')

  // Written after the step, by the real writers: both create a sibling temp file and rename it.
  const store = new ConfigStore(dataDir, { storageDir: storage }).load()
  store.set('ui.feedbackEmail', 'a@b.c')
  store.flush()
  writeRelaySeedHex(storage, SEED, { safeStorage: fakeSafeStorage })
  const configFile = path.join(dataDir, 'config.json')
  const vaultFile = seedFile(storage)
  t.is(path.dirname(vaultFile), dataDir, 'the vault is written in the folder the ACL is set on')

  const children = [existingFile, storage, path.dirname(nestedFile), nestedFile, configFile, vaultFile, path.join(dataDir, '.owner-acl-v1')]
  const { me, byPath } = readAcls([dataDir, ...children])
  const expected = [SYSTEM, me].sort()
  t.comment(`account ${me}`)
  for (const [file, acl] of byPath) t.comment(`${path.relative(path.dirname(dataDir), file)} ${acl.sddl}`)

  const root = byPath.get(dataDir)
  t.ok(root.protected, 'the folder no longer inherits from its parent')
  t.alike(sids(root), expected, 'its entries are this account and SYSTEM, nobody else')
  for (const rule of root.rules) {
    t.ok(rule.allow && rule.rights === FULL_CONTROL && !rule.inherited, `${rule.sid} has full control, set on the folder itself`)
    t.ok(rule.inheritance === OBJECT_AND_CONTAINER_INHERIT && rule.propagation === 0, `${rule.sid}'s entry passes down to files and folders`)
  }

  for (const child of children) {
    const acl = byPath.get(child)
    const name = path.relative(dataDir, child)
    t.alike(sids(acl), expected, `${name}: this account and SYSTEM, nobody else`)
    t.ok(acl.rules.every((rule) => rule.inherited && rule.allow && rule.rights === FULL_CONTROL), `${name}: full control, inherited from the data folder`)
  }

  for (const [file, acl] of byPath) {
    for (const [sid, who] of Object.entries(BROAD)) {
      t.absent(acl.rules.some((rule) => rule.sid === sid), `${path.relative(path.dirname(dataDir), file)}: no entry for ${who}`)
    }
  }
})
