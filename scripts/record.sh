#!/usr/bin/env bash
# Copyright (c) 2026 Erick Bourgeois, Recess
# SPDX-License-Identifier: Apache-2.0
#
# Record a view's demo into docs/media: a GIF for the README (sped up) and an MP4 of the whole
# tour at real speed. The demo runs with placeholder values only (an empty config, example.com
# URLs), so nothing of the recording machine's setup is in it.
#
# usage: scripts/record.sh [agentsandbox|kubernetes|admin]...   (all three by default)
#
# RECORD_URL records from a demo already running (its sign-in link, as `recess web --demo`
# prints it), for instance one on a build host behind an SSH tunnel; nothing is built then.
#
# Needs: cargo (unless RECORD_URL), node (20 or newer), ffmpeg, and Chrome or Chromium (CHROME
# names the binary).
set -euo pipefail
cd "$(dirname "$0")/.."
views=("$@")
[ ${#views[@]} -gt 0 ] || views=(agentsandbox kubernetes admin)
work=$(mktemp -d)
trap '[ -z "${server:-}" ] || kill "$server" 2>/dev/null || true; rm -rf "$work"' EXIT
port=${PORT:-7497}

if [ -z "${RECORD_URL:-}" ]; then
  cargo build --release
  : > "$work/empty.env"
  mkdir -p "$work/xdg"
  env -i HOME="$HOME" PATH="$PATH" XDG_CONFIG_HOME="$work/xdg" RECESS_DEMO_PACE="${RECESS_DEMO_PACE:-3}" \
    MEDIATORE_ISSUER=https://dex.example.com MEDIATORE_URL=https://mediatore.example.com \
    ./target/release/recess --config "$work/empty.env" web --view agentsandbox --demo --no-open \
    --listen "127.0.0.1:$port" > "$work/link" 2> "$work/server.log" &
  server=$!
  disown "$server"
  for _ in $(seq 50); do [ -s "$work/link" ] && break; sleep 0.2; done
  RECORD_URL=$(head -1 "$work/link")
fi

mkdir -p docs/media
for view in "${views[@]}"; do
  case "$view" in
    agentsandbox) speed=2.2 ;;
    kubernetes) speed=1.6 ;;
    admin) speed=1.9 ;;
    *) echo "unknown view: $view" >&2; exit 2 ;;
  esac
  frames="$work/frames-$view"
  node "scripts/record-$view.mjs" "$RECORD_URL" "$frames"
  ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$frames/frames.txt" \
    -vf "setpts=PTS/$speed,fps=7,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=40:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    "docs/media/$view.gif"
  ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$frames/frames.txt" \
    -vf "fps=24,scale=1120:-2:flags=lanczos,format=yuv420p" -c:v libx264 -crf 27 -preset slow \
    -movflags +faststart "docs/media/$view.mp4"
  ls -la "docs/media/$view.gif" "docs/media/$view.mp4"
done
