#!/usr/bin/env bash
# Copyright (c) 2026 Erick Bourgeois, Recess
# SPDX-License-Identifier: Apache-2.0
#
# The docs' pictures, into docs/media: the map of the theatre (scripts/docs-map.mjs) and the
# screenshots of both views (scripts/docs-shots.mjs), taken from the demo with placeholder values
# only (an empty config, example.com URLs) and an empty layout, so no moved station is in them.
#
# Needs: cargo, node (20 or newer), and Chrome or Chromium (CHROME names the binary).
set -euo pipefail
cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'kill "${server:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT
port=${PORT:-7498}

node scripts/docs-map.mjs docs/media/layout-map.svg
cargo build --release
: > "$work/empty.env"
mkdir -p "$work/xdg"
env -i HOME="$HOME" PATH="$PATH" XDG_CONFIG_HOME="$work/xdg" \
  MEDIATORE_ISSUER=https://dex.example.com MEDIATORE_URL=https://mediatore.example.com \
  ./target/release/recess --config "$work/empty.env" web --view agentsandbox --demo --no-open \
  --listen "127.0.0.1:$port" > "$work/link" 2> "$work/server.log" &
server=$!
for _ in $(seq 50); do [ -s "$work/link" ] && break; sleep 0.2; done
node scripts/docs-shots.mjs "$(head -1 "$work/link")" docs/media
