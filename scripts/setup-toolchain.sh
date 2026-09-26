#!/usr/bin/env bash
# Installs the pinned firmware toolchain into .toolchain/ (gitignored):
#   arduino-cli 1.5.1 (checksum-pinned) + arduino:avr@1.8.8 core + ArduinoJson 7.4.2.
# Optional: VIBREAD_TOOLCHAIN_CACHE=<dir> with arduino-cli_1.5.1_Linux_64bit.tar.gz and/or packages/*.tar.* to skip downloads.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TC="$ROOT/.toolchain"
CLI_VERSION="1.5.1"
CLI_TARBALL="arduino-cli_${CLI_VERSION}_Linux_64bit.tar.gz"
CLI_SHA256="28a8e119c498a25607821c36cb2dc49e8463941b261a0d99091baa7bc692dd2b"
CLI_URL="https://github.com/arduino/arduino-cli/releases/download/v${CLI_VERSION}/${CLI_TARBALL}"
AVR_CORE="arduino:avr@1.8.8"
ARDUINOJSON="ArduinoJson@7.4.2"

mkdir -p "$TC/bin" "$TC/arduino/data" "$TC/arduino/downloads/packages" "$TC/arduino/user"

if [[ ! -x "$TC/bin/arduino-cli" ]] || ! "$TC/bin/arduino-cli" version | grep -q "$CLI_VERSION"; then
  tarball="$TC/$CLI_TARBALL"
  if [[ -n "${VIBREAD_TOOLCHAIN_CACHE:-}" && -f "$VIBREAD_TOOLCHAIN_CACHE/$CLI_TARBALL" ]]; then
    cp "$VIBREAD_TOOLCHAIN_CACHE/$CLI_TARBALL" "$tarball"
  else
    curl -fsSL "$CLI_URL" -o "$tarball"
  fi
  echo "$CLI_SHA256  $tarball" | sha256sum -c -
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
