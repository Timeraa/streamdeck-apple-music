#!/usr/bin/env bash
# Regenerate every committed PNG asset from source, so the plugin's artwork is
# fully reproducible:
#   * Brand art  (red tile + our own eighth-note glyph)  via make-brand.swift
#   * Playback glyphs (SF Symbols on a red/gray tile)     via make-symbols.swift
#
# This project ships NO Apple artwork. The brand glyph is hand-drawn (not Apple's
# logo); the playback glyphs are macOS SF Symbols rendered onto our own tile. The
# genuine Apple Music app icon is read from the user's installed Music.app at
# runtime by the helper (see `appicon` in music-volume.swift) and only ever shown
# on the live dial — it is never written to disk or bundled.
#
# Usage: native/make-art.sh
set -euo pipefail

cd "$(dirname "$0")"

IMGS="../com.timeraa.apple-music-volume.sdPlugin/imgs"
BUILD_DIR=".build"
BRAND="$BUILD_DIR/make-brand"
SYMBOLS="$BUILD_DIR/make-symbols"

mkdir -p "$BUILD_DIR"

echo "Compiling generators…"
swiftc -O -o "$BRAND" make-brand.swift
swiftc -O -o "$SYMBOLS" make-symbols.swift

echo "Brand art (original tile + note)…"
# Plugin Icon + CategoryIcon (256, @2x 512).
"$BRAND" "$IMGS/plugin/category-icon.png" 256
"$BRAND" "$IMGS/plugin/category-icon@2x.png" 512
# Volume action + Encoder icon (72, @2x 144).
"$BRAND" "$IMGS/actions/volume/icon.png" 72
"$BRAND" "$IMGS/actions/volume/icon@2x.png" 144
# Dial touchscreen fallback (144) — used until the live Music.app icon arrives.
"$BRAND" "$IMGS/actions/volume/music.png" 144
"$BRAND" "$IMGS/actions/volume/music-muted.png" 144 muted

echo "Playback glyphs (SF Symbols on a tile)…"
PB="$IMGS/playback"
# <file> <symbol> <tile>  — red = active / Apple Music, gray = inactive toggle.
gen() { "$SYMBOLS" "$PB/$1.png" 72 "$2" "$3"; "$SYMBOLS" "$PB/$1@2x.png" 144 "$2" "$3"; }

gen mute        speaker.fill          red    # Volume action "Sound" state
gen mute-on     speaker.slash.fill    gray   # Volume action "Muted" state
gen volup       speaker.wave.3.fill   red    # Volume key — raise
gen voldown     speaker.wave.1.fill   red    # Volume key — lower
gen play        play.fill             red
gen pause       pause.fill            red
gen next        forward.end.fill      red
gen prev        backward.end.fill     red
gen heart       heart                 gray   # Like — not loved
gen heart-fill  heart.fill            red    # Like — loved
gen shuffle-off shuffle               gray
gen shuffle-on  shuffle               red
gen repeat-off  repeat                gray
gen repeat-all  repeat                red
gen repeat-one  repeat.1             red

echo "Done. Regenerated brand + playback art under $IMGS"
