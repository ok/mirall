# Unit tests

Pure-logic tests of `src/shared/*` and `src/renderer/*` helpers — **no I/O, no networking, no Corestore/Hyperdrive**. Validators, encoders/decoders, parsers, the IPC dispatch state machine, the echo-guard TTL map, and runtime-config. Fast (whole suite is milliseconds) and fully deterministic; the only "clock" is faked (`echo-guard`).

- **Runner:** `npm run test:unit` (just this layer) or `npm run test:node` (unit + flow). Files match `test/unit/*.test.js`, run by `brittle-node` (Node, not Bare).
- **What belongs here:** a function you can call with plain arguments and assert a return value or thrown error, with no external state. The moment a test needs a real drive, the filesystem, or a second peer, it belongs at **integration** (`test/integration/`) or **flow** (`test/flow/`) — see those READMEs and `.claude/testing.md` §1.
- **Boundary, stated plainly:** most of the operations this gap analysis cares about (publishing a folder, materializing on a mirror, deleting, copying, moving) are *inherently* I/O or multi-peer and are owned by the integration/flow suites. What lives here is the **load-bearing pure logic underneath them** — the path math, prefix matching, overlap detection, and collision picking that, if wrong, silently corrupts those operations on every platform at once. Those are the gaps below.

---

## Existing tests

### A. Invite codes & deep-link parsing
| File | Scenarios |
|------|-----------|
| `invite-envelope.test.js` | `encodeInvite`/`decodeInvite`: legacy bare/dashed/uppercase/whitespace hex → v0; base64url shape (no `=`/`+`/`/`); topic+name round-trip; name omitted / empty / truncated at `NAME_MAX` (both on encode and from the wire); UTF-8 names; uppercase-topic normalisation; rejects non-hex / wrong-length topic; `decode` → `null` for non-string, empty, malformed base64, valid-base64-invalid-JSON, missing topic, non-hex topic, unknown version, JSON array, JSON `null`, numeric name. |
| `deeplink.test.js` | `parseDeepLink`: dashed / bare / uppercase hex in path; envelope in path and in `?code=`; name omitted when envelope has none; percent-encoded path code; `null` for wrong scheme, wrong verb, missing code, malformed code, non-string input, unparseable URL. |
| `invite-code.test.js` | `formatInviteCode` groups 64-hex into 8 octets; `parseInviteCode` strips dashes; `parse(format(x))` round-trip identity; non-multiple-of-8 length keeps a short trailing group and still round-trips. |

### B. Share names & path display
| File | Scenarios |
|------|-----------|
| `shares-validation.test.js` | `isValidShareName`: accepts ordinary / trimmed / 255-char names; rejects non-strings, empty / whitespace-only / 256+, illegal path chars (`\ / < > : " \| ? *`), control chars (`\x00`, `\t`), `.` and `..` (but `...` is legal). `generateShareId` matches `<base36ts>-<rand>` and is collision-free across 200 ids. |
| `share-paths.test.js` | `mountPathFromDrop`: **REGRESSION (FIX-DROP-1)** a dropped folder resolves to itself, not its parent (share name is the folder, not `user1`); trims a single trailing separator (POSIX + Windows); tolerates empty/non-string. `basename`: last segment across separators + trailing slashes + bare name; empty/non-string. `splitPathForDisplay`: directory in head / filename in tail; bare filename / root entry entirely in tail. |

### C. IPC transport
| File | Scenarios |
|------|-----------|
| `ipc.test.js` | `createIPC`: requests queue until `start()` then dispatch; NDJSON frame split across chunks reassembles; unknown command → `NOT_FOUND`; handler rejection returns `error` + `code` (default `UNKNOWN`); a `bootstrap` line resolves `getBootstrapPromise` and is **not** dispatched; `emit` writes `{type, ...payload}` and `respond` with no id is a no-op; a malformed JSON line is skipped, not fatal (recovers on the next line). |

### D. Transfer-error classification
| File | Scenarios |
|------|-----------|
| `errors.test.js` | `classifyTransferError`: fs codes (`ENOSPC`→disk-full, `EACCES`/`EPERM`→permission); message substrings, case-insensitive (checksum / signature / "block not available" / "not found"); falls back to `NETWORK`; tolerates `null`/`undefined`/missing message; `code` beats `message`. `isRetryableTransferError` true only for `NETWORK`. |

### E. Publish loop-prevention (echo-guard)
| File | Scenarios |
|------|-----------|
| `echo-guard.test.js` | `ignorePathsFor`/`clearShareGuards` on a **faked clock**: add → `has` within TTL → delete; auto-expiry exactly at the 30s TTL boundary; guards isolated per share id; `clearShareGuards` drops the whole bucket (a fresh bucket sees nothing). |

### F. Runtime config
| File | Scenarios |
|------|-----------|
| `runtime-config.test.js` | `downloadFolder` defaults to `null` when absent; read from the bootstrap payload; empty string normalised to `null`; `setDownloadFolder` updates the value without touching `storage`/`appVersion`/`dev`/`verbose`. |

### G. Pure path / key / prefix logic — the file & folder operation backbone (`path-keys`)
The platform-divergent string math behind every share / subfolder / move / copy / delete. Extracted into the zero-dependency `src/shared/path-keys.js` so it loads under plain Node and is the single source of truth the heavy data-layer modules import (see "How these became unit tests" below).
| File | Scenarios |
|------|-----------|
| `path-keys.test.js` | **rel ⇄ drive-key** (`relToDriveKey`/`driveKeyToSegments`): OS-sep → POSIX key; round-trip on **both** POSIX and Windows separators; top-level + nested. **Share prefix/membership** (`sharePrefix`/`isInsideShare`/`isInsideAnyShare`/`relPathInShare`): matches direct + nested-subfolder files, excludes the `/Docsfoo` name-prefix sibling, strips the prefix preserving subfolders. **Mount overlap** (`pathsOverlap`): equal/ancestor/descendant true, `/a/b` vs `/a/bc` sibling false, Windows separator. **Collision naming** (`splitFileName`/`nextFreeName`): `path.extname` parity (`a.tar.gz`, `LICENSE`, `.bashrc`, `file.`), `name (n)` walk, extension-less suffixing, in-flight `.partial` treated as taken. **Deletion safety** (`shouldHonorDeletions`): four-quadrant truth table. **Ignore globs** (`shouldIgnore`/`DEFAULT_IGNORE`): exact basename anywhere, suffix-vs-prefix, `dir/**` deep nesting + look-alikes, empty/missing patterns. **Mount name rules** (`systemRootViolation`/`isWindowsReservedName`/`firstWinReservedSegment`): per-platform system roots, reserved device names with extension/case, name-prefix-sibling allowance. **Cloud-sync detection** (`cloudSyncHint`, gates a hard mount rejection): provider detection, ordinary folder → none. |

**Coverage at a glance:** ~95 scenarios across 10 files — the *invite/join surface*, *input validation*, and now the *pure file/folder operation backbone*. The data-layer I/O and multi-peer convergence for those operations stays at integration/flow by necessity; what this layer pins is the pure logic underneath them, where a cross-platform bug is cheapest to catch.

---

## How these became unit tests (the `path-keys` extraction)

The SEV1–3 gaps below were all **pure logic**, but they lived in modules that import `bare-path`/`bare-fs`/`bare-os`, which **do not load under plain Node** (`brittle-node`). That's the same reason `resolveDest`, `shouldHonorDeletions`, and `shouldIgnore` had only *integration* (Bare) tests despite being pure. To make them genuine fast Node unit tests **without duplicating logic**, the pure functions were lifted into a zero-import module **`src/shared/path-keys.js`** and the heavy modules (`owned-folders`, `foreign-folders`, `files`, `share-view`, `mount-validate`, `transfers`) now import from it — a single source of truth that also removed the 3× duplicated `split(sep).join('/')` conversion. The pre-existing integration tests still import via the original module paths and stay green, now doubling as wiring guards. Verified: unit + integration + flow all green; typecheck + lint clean.

## Gap analysis — implemented, and what remains

The brief was the critical file/folder paths: **sharing files, sharing folders, deleting files/folders, creating subfolders, copying files, moving files into subfolders, deleting files in folders and subfolders.** Each operation is I/O or multi-peer (owned by integration/flow), but each rests on pure logic that a bug corrupts silently, on every platform, before any I/O runs. **SEV1–3 are now implemented** in Group G above:

### SEV-1 — silent data corruption / cross-platform breakage ✅ implemented
| # | Pure logic | Now in | Guards |
|---|------------|--------|--------|
| 1 | **`relToDriveKey`/`driveKeyToSegments`** separator round-trip (POSIX + Windows) | `path-keys.js` | creating subfolders, moving/copying files into subfolders |
| 2 | **`isInsideAnyShare`/`sharePrefix`/`isInsideShare`/`relPathInShare`** boundary (rejects the `/Docsfoo` false positive) | `path-keys.js` | sharing a folder; listing files in folders/subfolders |
| 3 | **`pathsOverlap`** (equal/ancestor/descendant; `/a/b` vs `/a/bc` is *not* an overlap) | `path-keys.js` | sharing a folder nested in another; subfolder collisions |

### SEV-2 — wrong result / unsafe propagation ✅ implemented
| # | Pure logic | Now in | Guards |
|---|------------|--------|--------|
| 4 | **`splitFileName`/`nextFreeName`** collision walk (never clobbers an existing file or in-flight `.partial`) | `path-keys.js` | copying a file / downloading when a same-named file exists |
| 5 | **`shouldHonorDeletions`** four-quadrant truth table | `path-keys.js` | deleting files in shared folders/subfolders (mirror propagation) |
| 6 | **`shouldIgnore`/`DEFAULT_IGNORE`** glob matcher (incl. `dir/**` deep nesting) | `path-keys.js` | ignored junk in subfolders; `*.partial`/`*~` on copy |

### SEV-3 — robustness / advisory correctness ✅ implemented (except the noted #9)
| # | Pure logic | Now in | Guards |
|---|------------|--------|--------|
| 7 | **`systemRootViolation`/`isWindowsReservedName`/`firstWinReservedSegment`** | `path-keys.js` | choosing where a shared folder lives (reject system/reserved paths) |
| 8 | **`cloudSyncHint`** cloud-provider detection | `path-keys.js` | hard-rejects sharing/mirroring a folder inside Dropbox/OneDrive/iCloud/… ("double-syncing can cause data loss") |
| 9 | `feedback.js` / `install-id.js` / `storage.js` formatting | **not done — out of scope** | These import `bare-*` and their core *is* the I/O (HTTPS upload, id-file read/write, drive byte accounting); there is no pure surface to extract that relates to the file/folder paths. Left as a peripheral, low-blast-radius follow-up — cover at integration if needed. |

### What still belongs elsewhere (not unit-able)
The *operations themselves* remain at the higher layers and are already covered there: end-to-end subfolder/move/copy/delete and download-collision in `test/flow/`; single-peer publish/materialize/mount-validate and the `resolveDest`/`shouldHonorDeletions`/`shouldIgnore` behaviour against real drives in `test/integration/`. This unit layer pins the pure core; the convergence and byte-level behaviour stay where a real drive or a second peer is available.

### Layering principle
Keep the **pure path/prefix/predicate math** here — cheapest place to catch a cross-platform bug and the only place an exhaustive table is practical. Anything needing a real drive, the filesystem, or a second peer goes to `test/integration/` / `test/flow/`. Where an operation has both, the pure core is unit-tested here and the I/O/convergence stays in the higher layer.
