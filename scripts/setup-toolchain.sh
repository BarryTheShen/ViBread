#!/usr/bin/env bash
# Installs the pinned firmware toolchain into .toolchain/ (gitignored):
#   arduino-cli 1.5.1 (checksum-pinned) + arduino:avr@1.8.8 core + ArduinoJson 7.4.2.
# Supported hosts: Linux x86_64/arm64 and macOS Intel/Apple silicon (Windows: run inside WSL2).
# Optional: VIBREAD_TOOLCHAIN_CACHE=<dir> with the arduino-cli tarball and/or packages/*.tar.* to skip downloads.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TC="$ROOT/.toolchain"
CLI_VERSION="1.5.1"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  CLI_ASSET="Linux_64bit";  CLI_SHA256="28a8e119c498a25607821c36cb2dc49e8463941b261a0d99091baa7bc692dd2b" ;;
  Linux-aarch64 | Linux-arm64) CLI_ASSET="Linux_ARM64"; CLI_SHA256="1e69e077479f300614d4551334e0a33f08ee40b04315d83b8e7e0e94f0d0ee62" ;;
  Darwin-x86_64) CLI_ASSET="macOS_64bit";  CLI_SHA256="c982e940027996bea9901050e95fae99c59c1dcfee54beedecaf28141e7bf2e7" ;;
  Darwin-arm64)  CLI_ASSET="macOS_ARM64";  CLI_SHA256="cb952e8c1621c95ef5f1d17831c945e3d0ec5973f89c557a7ec8feb9c4f7d4c9" ;;
  *) echo "Unsupported host $(uname -s)-$(uname -m): use Linux, macOS, or WSL2 on Windows." >&2; exit 1 ;;
esac
CLI_TARBALL="arduino-cli_${CLI_VERSION}_${CLI_ASSET}.tar.gz"
CLI_URL="https://github.com/arduino/arduino-cli/releases/download/v${CLI_VERSION}/${CLI_TARBALL}"
AVR_CORE="arduino:avr@1.8.8"
ARDUINOJSON="ArduinoJson@7.4.2"

sha256_check() {
  if command -v sha256sum >/dev/null; then echo "$1  $2" | sha256sum -c -; else echo "$1  $2" | shasum -a 256 -c -; fi
}

mkdir -p "$TC/bin" "$TC/arduino/data" "$TC/arduino/downloads/packages" "$TC/arduino/user"

if [[ ! -x "$TC/bin/arduino-cli" ]] || ! "$TC/bin/arduino-cli" version | grep -q "$CLI_VERSION"; then
  tarball="$TC/$CLI_TARBALL"
  if [[ -n "${VIBREAD_TOOLCHAIN_CACHE:-}" && -f "$VIBREAD_TOOLCHAIN_CACHE/$CLI_TARBALL" ]]; then
    cp "$VIBREAD_TOOLCHAIN_CACHE/$CLI_TARBALL" "$tarball"
  else
    curl -fsSL "$CLI_URL" -o "$tarball"
  fi
  sha256_check "$CLI_SHA256" "$tarball"
  tar -xzf "$tarball" -C "$TC/bin" arduino-cli
  rm -f "$tarball"
fi

cat > "$TC/arduino/arduino-cli.yaml" <<EOF
board_manager:
    additional_urls: []
directories:
    data: $TC/arduino/data
    downloads: $TC/arduino/downloads
    user: $TC/arduino/user
EOF

if [[ -n "${VIBREAD_TOOLCHAIN_CACHE:-}" && -d "$VIBREAD_TOOLCHAIN_CACHE/packages" ]]; then
  cp -n "$VIBREAD_TOOLCHAIN_CACHE"/packages/* "$TC/arduino/downloads/packages/" 2>/dev/null || true
fi

CLI=("$TC/bin/arduino-cli" --config-file "$TC/arduino/arduino-cli.yaml")
if ! "${CLI[@]}" core list --json | grep -q '"id": *"arduino:avr"'; then
  "${CLI[@]}" core update-index
  "${CLI[@]}" core install "$AVR_CORE"
fi
if ! "${CLI[@]}" lib list --json | grep -q '"name": *"ArduinoJson"'; then
  "${CLI[@]}" lib update-index
  "${CLI[@]}" lib install "$ARDUINOJSON"
fi

"${CLI[@]}" version
"${CLI[@]}" core list
"${CLI[@]}" lib list
