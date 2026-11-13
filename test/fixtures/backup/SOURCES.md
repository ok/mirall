Local backup folders written by released builds. Generated once, never regenerated or edited.

Each directory is a complete backup folder written by the release it is named after, run from a
checkout of that release's tag with its `npm ci` dependencies, by `scripts/backup-fixture/generate.mjs`.
The bytes are not reproducible (random repository key, nonces and ids), so `SHA256SUMS` is the record
of what the release wrote, and `test/invariants/backup-fixtures-frozen.test.js` holds every file to it.
`test/integration/backup-compat.test.js` restores each one on the current code. A failing restore is
fixed in the reader, never in the fixture. After each stable tag, its fixture is added as a new
directory with its row here and its lines in `SHA256SUMS`; nothing else changes.

| Release | Tag | Tag commit | hypercore | corestore | hypercore-storage | rocksdb-native | hyperbee | compact-encoding | bare-runtime | Files | Bytes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1.12.0 | v1.12.0 | 970d0eb3c5d68b203787fbbc94b6003f5ba51b54 | 11.37.2 | 7.13.0 | 3.2.1 | 3.17.4 | 2.27.3 | 3.5.2 | 1.34.1 | 14 | 46374 |
| 1.13.0 | v1.13.0 | f647579aeef0c31d94abff33a255dc66621b2fec | 11.37.2 | 7.13.0 | 3.2.1 | 3.17.4 | 2.27.3 | 3.5.2 | 1.34.1 | 15 | 50515 |
| 1.13.1 | v1.13.1 | a016c196748fbe5738eba4b1a1e2ea11ee2f5efa | 11.37.2 | 7.13.0 | 3.2.1 | 3.17.4 | 2.27.3 | 3.5.2 | 1.34.1 | 15 | 50515 |

All three were generated on 2026-11-12 on macOS 27.2.1, Darwin arm64, by the generator with sha256
`21e9b99234f1c3d299d5b73a43ed7eb3a6ec60067c8f0ddfb3a9ab2c5a92064a`. 1.12.0 predates the settings
store, so the generator's adapter skips `loadSettings` for it.

**Test-only secrets.** Fixed in the generator, for these fixtures only; never a real identity:

- master secret: the 32 UTF-8 bytes `mirall-backup-fixture-test-only!`
- recovery key passphrase: `mirall backup fixture passphrase (test only)`
- identity KEK of the generating store (not part of a backup): hex of `mirall-fixture-kek-test-only....`

**What each backup holds.** Profile `Fixture Person`; one space `Fixture Space`; one owned folder
share `Project Notes` mounted at `/tmp/mirall-backup-fixture/Project Notes`, advertising
`readme.txt` and `todo.txt` in the first snapshot and `changelog.txt` too in the second (a delta on
the space's catalog core); carried settings
`{"appearance":{"theme":"dark"},"network":{"downloadKBps":333,"uploadKBps":0},"downloads":{"folder":"/Volumes/Gone/Downloads"}}`;
install id `fixture-install`; snapshots at 2026-10-01T10:00Z and 11:00Z; recovery key created
2026-10-01T11:30Z. File contents are never in a backup.

**What is readable without the key.** `mirall-backup.json` (format, version, repository id, creation
time, the wrapped repository key), `leases/fixture-install.json` (install id, last run time),
`keys/*.mirallkey` (creation time, identity public key, Argon2 parameters, the sealed master secret),
and the snapshot and object names. Every object and snapshot is sealed.
