#!/usr/bin/env bash
# Build the music-volume helper as a universal (arm64 + x86_64) binary and
# install it into the plugin bundle's bin/ directory.
set -euo pipefail

cd "$(dirname "$0")"

SRC="music-volume.swift"
OUT_DIR="../com.timeraa.apple-music-volume.sdPlugin/bin"
OUT="$OUT_DIR/music-volume"
BUILD_DIR=".build"

mkdir -p "$OUT_DIR" "$BUILD_DIR"

echo "Compiling arm64…"
swiftc -O -target arm64-apple-macos12 -o "$BUILD_DIR/music-volume-arm64" "$SRC"

echo "Compiling x86_64…"
swiftc -O -target x86_64-apple-macos12 -o "$BUILD_DIR/music-volume-x86_64" "$SRC"

echo "Creating universal binary…"
lipo -create \
  "$BUILD_DIR/music-volume-arm64" \
  "$BUILD_DIR/music-volume-x86_64" \
  -output "$OUT"

chmod +x "$OUT"

echo "Done: $OUT"
lipo -info "$OUT"
