#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/package.json"
[ -f "$PKG" ] || { echo "package.json not found in $ROOT" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

UNAME_ARCH=$(uname -m)
case "$UNAME_ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64 | arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $UNAME_ARCH" >&2; exit 1 ;;
esac

APP_BUILDER=""
ALT=$(find "$ROOT/node_modules" -path "*app-builder-bin/linux/$ARCH/app-builder" -type f 2>/dev/null | head -1)
if [ -n "$ALT" ]; then
  echo "Found app-builder in node_modules: $ALT"
  APP_BUILDER="$ALT"
else
  APP_BUILDER_VERSION="${APP_BUILDER_VERSION:-4.2.0}"
  echo "app-builder-bin not in node_modules. Fetching v${APP_BUILDER_VERSION} from npm registry..." >&2
  TMPDIR_ABB="$(mktemp -d)"
  TGZ="$TMPDIR_ABB/app-builder-bin.tgz"
  URL="https://registry.npmjs.org/app-builder-bin/-/app-builder-bin-${APP_BUILDER_VERSION}.tgz"
  if ! curl -fsSL "$URL" -o "$TGZ"; then
    echo "Download failed: $URL" >&2
    exit 1
  fi
  tar -xzf "$TGZ" -C "$TMPDIR_ABB"
  APP_BUILDER="$TMPDIR_ABB/package/linux/$ARCH/app-builder"
  if [ ! -f "$APP_BUILDER" ]; then
    echo "Extracted tarball does not contain linux/$ARCH/app-builder" >&2
    find "$TMPDIR_ABB/package" -name app-builder -type f >&2
    exit 1
  fi
fi

chmod +x "$APP_BUILDER"
echo "Using app-builder: $APP_BUILDER"

APP_NAME=$(jq -r '.productName // .name' "$PKG")
VERSION=$(jq -r '.version' "$PKG")
DESCRIPTION=$(jq -r '.description // ""' "$PKG")

APP_DIR="$ROOT/out/${APP_NAME}-linux-${ARCH}"
STAGE_DIR="$ROOT/out/make/__appImage-${ARCH}"
OUT_DIR="$ROOT/out/make"
OUTPUT="$OUT_DIR/${APP_NAME}.AppImage"

[ -d "$APP_DIR" ] || { echo "Packaged app dir not found: $APP_DIR" >&2; exit 1; }

mkdir -p "$STAGE_DIR" "$OUT_DIR"

ICON_SIZES=(16 32 48 64 128 256)
ICONS_JSON=()
ASSETS_DIR="$ROOT/resources/linux/icons"
DEFAULT_ICON_BASE="$ROOT/node_modules/app-builder-lib/templates/icons/electron-linux"

for SIZE in "${ICON_SIZES[@]}"; do
  CUSTOM_ICON="$ASSETS_DIR/${SIZE}x${SIZE}.png"
  if [ -f "$CUSTOM_ICON" ]; then
    ICONS_JSON+=("{\"file\":\"$CUSTOM_ICON\",\"size\":$SIZE}")
  else
    DEFAULT_ICON="$DEFAULT_ICON_BASE/${SIZE}x${SIZE}.png"
    if [ -f "$DEFAULT_ICON" ]; then
      ICONS_JSON+=("{\"file\":\"$DEFAULT_ICON\",\"size\":$SIZE}")
    fi
  fi
done
ICON_JSON="[$(IFS=,; echo "${ICONS_JSON[*]}")]"

DESKTOP_ENTRY=$(cat <<EOF
[Desktop Entry]
Name=${APP_NAME}
Exec=${APP_NAME}
Terminal=false
Type=Application
Icon=${APP_NAME}
StartupWMClass=${APP_NAME}
X-AppImage-Version=${VERSION}
X-AppImage-Integrate=false
Comment=${DESCRIPTION}
Categories=Utility;Network;FileTransfer;
EOF
)

MIME_TYPES=$(jq -r '
  (.build?.protocols // .protocols // [])
  | map(.schemes // []) | add // []
  | map("x-scheme-handler/" + ascii_downcase)
  | join(";")
' "$PKG")
if [ -n "$MIME_TYPES" ] && [ "$MIME_TYPES" != "null" ]; then
  DESKTOP_ENTRY="${DESKTOP_ENTRY}"$'\n'"MimeType=${MIME_TYPES};"
fi

CONFIG_JSON=$(jq -n \
  --arg name "$APP_NAME" \
  --arg desktop "$DESKTOP_ENTRY" \
  --argjson icons "$ICON_JSON" \
  '{
    productName: $name,
    productFilename: $name,
    desktopEntry: $desktop,
    executableName: $name,
    icons: $icons,
    fileAssociations: []
  }'
)

CUSTOM_APPRUN="$ROOT/resources/linux/AppRun"
if [ -f "$CUSTOM_APPRUN" ]; then
  echo "Using custom AppRun: $CUSTOM_APPRUN"
  cp "$CUSTOM_APPRUN" "$STAGE_DIR/AppRun"
  chmod +x "$STAGE_DIR/AppRun"
fi

# app-builder's `appimage` command defaults to `-comp zstd`, but the mksquashfs
# that electron-builder-binaries ships in appimage-13.0.0 for linux-arm64 was
# built without zstd support (only gzip/xz), so the arm64 build dies with
# `Compressor "zstd" is not supported!`. Pin xz: it's supported by both the x64
# and arm64 mksquashfs binaries and yields smaller AppImages than gzip.
APPIMAGE_COMPRESSION="${APPIMAGE_COMPRESSION:-xz}"

echo "Running app-builder appimage for arch=$ARCH (compression=$APPIMAGE_COMPRESSION)..."
"$APP_BUILDER" appimage \
  --stage "$STAGE_DIR" \
  --arch "$ARCH" \
  --compression "$APPIMAGE_COMPRESSION" \
  --output "$OUTPUT" \
  --app "$APP_DIR" \
  --configuration "$CONFIG_JSON"

ARCH_OUT="$ROOT/out/make/${APP_NAME}-linux-${ARCH}.AppImage"
if [ "$OUTPUT" != "$ARCH_OUT" ]; then
  mv "$OUTPUT" "$ARCH_OUT"
fi
chmod +x "$ARCH_OUT"

# Issue #44: replace the FUSE-based AppImage runtime with VHSgunzo/uruntime in
# extract-and-run mode (URUNTIME_MOUNT=0). The stock runtime that app-builder
# bakes in requires libfuse2 on the user's machine, which Ubuntu 24.04 and
# Fedora 40+ no longer ship by default — the app fails to launch silently for
# anyone who hasn't manually installed libfuse2t64. uruntime extracts the
# squashfs payload to a temp dir on launch and execs from there, no FUSE.
URUNTIME_VERSION="${URUNTIME_VERSION:-v0.5.7}"
case "$ARCH" in
  x64)   URUNTIME_ARCH="x86_64"  ;;
  arm64) URUNTIME_ARCH="aarch64" ;;
  *) echo "Unsupported uruntime arch: $ARCH" >&2; exit 1 ;;
esac

URUNTIME_TMP="$(mktemp -d)"
trap 'rm -rf "$URUNTIME_TMP"' EXIT
URUNTIME="$URUNTIME_TMP/uruntime"
URL="https://github.com/VHSgunzo/uruntime/releases/download/${URUNTIME_VERSION}/uruntime-appimage-squashfs-lite-${URUNTIME_ARCH}"
echo "Downloading uruntime ${URUNTIME_VERSION} (${URUNTIME_ARCH})..."
curl -fsSL --retry 3 "$URL" -o "$URUNTIME"
chmod +x "$URUNTIME"
sed -i 's|URUNTIME_MOUNT=[0-9]|URUNTIME_MOUNT=0|' "$URUNTIME"

# Read squashfs offset by parsing the ELF section header table of the stock
# runtime that app-builder embedded. Avoids `--appimage-offset` (which would
# require libfuse2 on the build host because the runtime is dynamically
# linked against libfuse.so.2 — even just to print the offset, the loader
# resolves DT_NEEDED before main() runs).
OFFSET="$(python3 -c '
import struct, sys
with open(sys.argv[1], "rb") as f: hdr = f.read(64)
if hdr[:4] != b"\x7fELF": sys.exit("not ELF")
shoff   = struct.unpack("<Q", hdr[40:48])[0]
shentsz = struct.unpack("<H", hdr[58:60])[0]
shnum   = struct.unpack("<H", hdr[60:62])[0]
print(shoff + shentsz * shnum)
' "$ARCH_OUT")"
[ -n "$OFFSET" ] && [ "$OFFSET" -gt 0 ] || {
  echo "Failed to determine squashfs offset for $ARCH_OUT" >&2; exit 1
}
echo "Stock runtime ends at byte $OFFSET; swapping in uruntime ($(stat -c%s "$URUNTIME") bytes)"

PAYLOAD="$URUNTIME_TMP/payload.squashfs"
dd if="$ARCH_OUT" of="$PAYLOAD" bs=1M iflag=skip_bytes skip="$OFFSET" status=none
cat "$URUNTIME" "$PAYLOAD" > "$ARCH_OUT.new"
mv "$ARCH_OUT.new" "$ARCH_OUT"
chmod +x "$ARCH_OUT"

echo "AppImage written: $ARCH_OUT"
