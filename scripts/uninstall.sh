#!/usr/bin/env bash
# uninstall.sh — remove Mirall artifacts on the current OS.
#
# Usage:
#   ./scripts/uninstall.sh                  # remove Mirall (keep shared Pear runtime)
#   ./scripts/uninstall.sh --purge-runtime  # also wipe the platform-wide Pear runtime
#   ./scripts/uninstall.sh --dry-run        # print what would be removed
#   ./scripts/uninstall.sh -h|--help
#
# Windows users: see scripts/uninstall-windows.ps1

set -u

PURGE_RUNTIME=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --purge-runtime) PURGE_RUNTIME=1 ;;
    --dry-run)       DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
rm_path() {
  local p=$1
  [ -e "$p" ] || [ -L "$p" ] || return 0
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '   would remove: %s\n' "$p"
  else
    rm -rf -- "$p" && printf '   removed: %s\n' "$p"
  fi
}

OS=$(uname -s)
case "$OS" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *)      echo "unsupported OS: $OS (Windows: use scripts/uninstall-windows.ps1)" >&2; exit 1 ;;
esac
say "detected platform: $PLATFORM   purge-runtime=$PURGE_RUNTIME   dry-run=$DRY_RUN"

say "stopping running mirall processes"
if [ "$DRY_RUN" -eq 0 ]; then
  pkill -f -i mirall 2>/dev/null || true
  pkill -f 'pear://' 2>/dev/null || true
fi

say "removing legacy debug logs"
rm_path "$HOME/mirall-install.log"
rm_path "$HOME/mirall-runtime.log"

if [ "$PLATFORM" = "macos" ]; then
  say "removing app bundle"
  rm_path "/Applications/Mirall.app"
  rm_path "$HOME/Applications/Mirall.app"

  say "removing user library artifacts"
  rm_path "$HOME/Library/Preferences/com.mirall.app.plist"
  rm_path "$HOME/Library/Preferences/com.mirall.Mirall.plist"
  rm_path "$HOME/Library/Saved Application State/com.mirall.app.savedState"
  rm_path "$HOME/Library/Saved Application State/com.mirall.Mirall.savedState"
  rm_path "$HOME/Library/Caches/com.mirall.app"
  rm_path "$HOME/Library/Caches/com.mirall.Mirall"
  rm_path "$HOME/Library/Caches/Mirall"
  rm_path "$HOME/Library/Logs/Mirall"
  rm_path "$HOME/Library/Application Support/Mirall"

  PEAR_DIR="$HOME/Library/Application Support/pear"
fi

if [ "$PLATFORM" = "linux" ]; then
  say "removing desktop entries and icons"
  for f in "$HOME/.local/share/applications/"*mirall* "$HOME/.local/share/applications/"*Mirall*; do
    [ -e "$f" ] && rm_path "$f"
  done
  # appimaged drops ~/.local/share/applications/appimagekit_<hash>.desktop
  # for any AppImage it sees, even with X-AppImage-Integrate=false. Match by
  # content since the hash filename isn't stable. Remove the paired thumbnail
  # under ~/.cache/thumbnails too — its basename is the same <hash>.
  for f in "$HOME/.local/share/applications/appimagekit_"*.desktop; do
    [ -e "$f" ] || continue
    if grep -qxF 'Name=Mirall' "$f" 2>/dev/null; then
      ident=$(grep -m1 '^X-AppImage-Identifier=' "$f" 2>/dev/null | cut -d= -f2-)
      rm_path "$f"
      if [ -n "${ident:-}" ]; then
        rm_path "$HOME/.cache/thumbnails/normal/${ident}.png"
        rm_path "$HOME/.cache/thumbnails/large/${ident}.png"
      fi
    fi
  done
  for f in "$HOME/.local/share/icons/hicolor/"*/apps/*mirall* "$HOME/.local/share/icons/hicolor/"*/apps/*Mirall*; do
    [ -e "$f" ] && rm_path "$f"
  done
  if [ "$DRY_RUN" -eq 0 ]; then
    command -v update-desktop-database >/dev/null 2>&1 && \
      update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  fi

  say "removing AppImage extraction and caches"
  rm_path "$PWD/squashfs-root"
  for d in "$HOME/.cache/appimage"*; do rm_path "$d"; done

  say "removing Electron userData and caches"
  # Electron's app.getPath('userData') on Linux = ~/.config/<productName>/
  # Cache lives at ~/.cache/<productName>/. Older builds used 'pear-runtime'
  # as the binary name; cover both.
  rm_path "$HOME/.config/Mirall"
  for d in "$HOME/.cache/Mirall"* "$HOME/.cache/pear-runtime"*; do
    [ -e "$d" ] && rm_path "$d"
  done

  say "removing snap user data (if present)"
  rm_path "$HOME/snap/mirall"

  PEAR_DIR="${SNAP_USER_COMMON:-$HOME/.config}/pear"
fi

if [ "$PURGE_RUNTIME" -eq 1 ]; then
  say "purging Pear runtime at $PEAR_DIR"
  rm_path "$PEAR_DIR"
else
  say "keeping Pear runtime at $PEAR_DIR (pass --purge-runtime to remove)"
fi

say "done"
