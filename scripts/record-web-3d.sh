#!/usr/bin/env bash
# Copyright (c) 2026 Erick Bourgeois, Recess
# SPDX-License-Identifier: Apache-2.0
#
# Record the web-3d demo into docs/media: a GIF for the README (2.2x speed) and an MP4 of the
# whole tour at real speed. The demo runs with placeholder values only (an empty config,
# example.com URLs), so nothing of the recording machine's setup is in it.
#
# Needs: cargo, node (20 or newer), ffmpeg, and Chrome or Chromium (CHROME names the binary).
set -euo pipefail
cd "$(dirname "$0")/.."
work=$(mktemp -d)
trap 'kill "${server:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT
port=${PORT:-7497}

cargo build --release
: > "$work/empty.env"
env -i HOME="$HOME" PATH="$PATH" RECESS_DEMO_PACE="${RECESS_DEMO_PACE:-3}" \
  MEDIATORE_ISSUER=https://dex.example.com MEDIATORE_URL=https://mediatore.example.com \
  ./target/release/recess --config "$work/empty.env" web --theme wired-3d --demo --no-open \
  --listen "127.0.0.1:$port" > "$work/link" 2> "$work/server.log" &
server=$!
disown "$server"
for _ in $(seq 50); do [ -s "$work/link" ] && break; sleep 0.2; done
node scripts/record-web-3d.mjs "$(head -1 "$work/link")" "$work/frames"

mkdir -p docs/media
cd "$work/frames"
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i frames.txt \
  -vf "setpts=PTS/2.2,fps=8,scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=48:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  "$OLDPWD/docs/media/web-3d.gif"
ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i frames.txt \
  -vf "fps=24,scale=1120:-2:flags=lanczos,format=yuv420p" -c:v libx264 -crf 27 -preset slow \
  -movflags +faststart "$OLDPWD/docs/media/web-3d.mp4"
cd "$OLDPWD"
ls -la docs/media/web-3d.gif docs/media/web-3d.mp4
