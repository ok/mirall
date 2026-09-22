#!/usr/bin/env bash
# Asserts the shape of the Linux .deb before it is uploaded. The package exists so the Chromium
# sandbox works on a real filesystem, which comes down to one file mode — chrome-sandbox 4755
# root:root — that nothing else in CI would notice a maker bump dropping. The rest pins the
# install layout the runtime relies on: the binary, the /usr/bin symlink, the desktop entry with
# the scheme handler, and the Bare tree unpacked beside the asar.
#
# Usage: scripts/ci/check-deb.sh <path/to/Mirall.deb> <forge arch: x64|arm64> <version as CI stamped it>
set -euo pipefail

DEB="$1"
FORGE_ARCH="$2"
VERSION="$3"
# electron-installer-debian rewrites a prerelease label to Debian's `~` form so a beta sorts below
# the release it precedes; a verbatim `-beta.N` would parse as a revision and sort ABOVE it, and apt
# would refuse the final release as a downgrade.
WANT_VERSION=$(sed -E 's/-(alpha|beta|dev|pre|rc)\.?([0-9]*)$/~\1\2/; s/~(alpha|beta|dev|pre|rc)([0-9]+)$/~\1.\2/' <<<"$VERSION")
case "$FORGE_ARCH" in
  x64)   WANT_ARCH=amd64 ;;
  arm64) WANT_ARCH=arm64 ;;
  *) echo "ERROR: unknown forge arch '$FORGE_ARCH'" >&2; exit 1 ;;
esac
[ -f "$DEB" ] || { echo "ERROR: $DEB is not a file" >&2; exit 1; }

fail=0
err() { echo "ERROR: $*" >&2; fail=1; }

listing=$(dpkg -c "$DEB")

sandbox=$(grep -E ' \./usr/lib/mirall/chrome-sandbox$' <<<"$listing" || true)
[ -n "$sandbox" ] || { echo "ERROR: chrome-sandbox missing from $DEB" >&2; exit 1; }
case "$sandbox" in
  -rwsr-xr-x\ root/root*) echo "ok: chrome-sandbox is setuid root" ;;
  *) err "chrome-sandbox mode/owner wrong: $sandbox" ;;
esac

grep -qE ' \./usr/lib/mirall/Mirall$' <<<"$listing" || err "binary not at /usr/lib/mirall/Mirall"
grep -qE ' \./usr/bin/mirall -> \.\./lib/mirall/Mirall$' <<<"$listing" || err "/usr/bin/mirall symlink wrong"
grep -qE ' \./usr/share/applications/mirall\.desktop$' <<<"$listing" || err "desktop entry missing"
grep -qE ' \./usr/share/icons/hicolor/256x256/apps/mirall\.png$' <<<"$listing" || err "hicolor icon missing"
grep -qE ' \./usr/lib/mirall/resources/app\.asar$' <<<"$listing" || err "app.asar missing"
grep -qE ' \./usr/lib/mirall/resources/app\.asar\.unpacked/src/worker/' <<<"$listing" || err "Bare tree not unpacked"

info=$(dpkg-deb --info "$DEB")
grep -qE '^ Package: mirall$' <<<"$info" || err "Package name"
grep -qE "^ Version: $WANT_VERSION\$" <<<"$info" || err "Version != $WANT_VERSION: $(grep '^ Version:' <<<"$info")"
grep -qE "^ Architecture: $WANT_ARCH$" <<<"$info" || err "Architecture != $WANT_ARCH"
grep -qE '^ Depends: .*libnss3' <<<"$info" || err "default Depends not resolved (Electron version file missing?)"
grep -qE '^ Maintainer: .+ <[^>]+@[^>]+>$' <<<"$info" || err "Maintainer has no email"
grep -qE '^ Homepage: https://mirall\.app$' <<<"$info" || err "Homepage"

# xz members: dpkg before Debian 12 cannot unpack the zstd that dpkg-deb defaults to on the runners.
ar t "$DEB" | grep -qx 'data.tar.xz' || err "data member is not xz: $(ar t "$DEB" | tr '\n' ' ')"

desktop=$(dpkg-deb --fsys-tarfile "$DEB" | tar -xO ./usr/share/applications/mirall.desktop)
grep -qx 'Exec=mirall %U' <<<"$desktop" || err "Exec line: $(grep '^Exec=' <<<"$desktop" || echo '<none>')"
grep -qx 'MimeType=x-scheme-handler/mirall;' <<<"$desktop" || err "scheme handler missing from the desktop entry"
grep -q 'no-sandbox' <<<"$desktop" && err "the deb must not launch with --no-sandbox"

# Informational: Electron packages always trip a known set of lintian tags (embedded libraries,
# a setuid binary, no changelog). Anything outside the allow-list is new and worth a look, but
# not a red build.
if command -v lintian >/dev/null 2>&1; then
  ALLOW='^(E|W): mirall: (changelog-file-missing-in-native-package|embedded-library|setuid-binary|unstripped-binary-or-object|binary-or-shlib-defines-rpath|extended-description-is-probably-too-short|no-copyright-file|package-installs-.*|shared-library-lacks-prerequisites|missing-dependency-on-libc|arch-dependent-file-in-usr-share|executable-not-elf-or-script|maintainer-script-.*)'
  echo "--- lintian (informational) ---"
  lintian --no-tag-display-limit "$DEB" 2>/dev/null | grep -vE "$ALLOW" || true
  echo "--- end lintian ---"
fi

[ "$fail" -eq 0 ] || exit 1
echo "check-deb: clean."
