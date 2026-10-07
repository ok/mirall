# Sourced by build scripts. A build input fetched over the network is accepted only when its
# SHA-256 equals the pin committed next to its URL; a mismatch deletes the file and fails.

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# verify_sha256 <file> <expected-hex>
verify_sha256() {
  local file="$1" expected="$2" actual
  if ! [[ "$expected" =~ ^[0-9a-f]{64}$ ]]; then
    echo "verify_sha256: pin '$expected' for $file is not a lowercase SHA-256" >&2
    rm -f "$file"
    return 1
  fi
  actual="$(sha256_of "$file")"
  if [ "$actual" != "$expected" ]; then
    echo "SHA-256 mismatch for $file" >&2
    echo "  expected $expected" >&2
    echo "  actual   $actual" >&2
    rm -f "$file"
    return 1
  fi
}

# fetch_verified <url> <expected-hex> <out>
fetch_verified() {
  if ! curl -fsSL --retry 3 "$1" -o "$3"; then
    echo "download failed: $1" >&2
    rm -f "$3"
    return 1
  fi
  verify_sha256 "$3" "$2"
}
