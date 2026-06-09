# Apple Music for Stream Deck (macOS)

Control **Apple Music** from your Elgato Stream Deck — volume on a dial, and full
transport on keys.

## Features

- **Volume** (Stream Deck + dial **or** keypad)
  - On a **dial**: rotate to change Music's output volume, press / touch to mute.
    The touchscreen shows the Apple Music icon, the current `NN%`, and a level
    bar; while muted a stripe crosses the icon and it reads `Muted`.
  - On a **key**: a Property Inspector dropdown picks raise / lower / mute, so the
    same action works without a dial. The key shows the live volume.
  - Volume is **reconciled** every second while the dial is visible, so changing
    the volume directly in Apple Music doesn't leave the dial showing a stale value.
- **Play / Pause** — toggles, with the icon reflecting the live player state.
- **Next Track** / **Previous Track**.
- **Like** — favorite / unfavorite the current track.
- **Shuffle** — toggle, icon reflects state.
- **Repeat** — cycle off → all → one, icon reflects state.
- **Cover art** — the dial/keys can show the current track's artwork. Catalog
  tracks not in your library expose no artwork via ScriptingBridge, so the plugin
  falls back to the **iTunes Search API** using the track's name/artist/album.

Mute is **volume-based** (Music sits at `0` while muted) rather than Music's
native `mute` property, which throws (error 9038) when nothing is playing and so
can't drive an always-responsive dial. The logical pre-mute level is kept in
action settings, so mute survives reloads and a rotate resumes from the real level.

## Artwork & Apple trademarks

**This project ships no Apple artwork.** Every bundled icon is original:

- The plugin / category / Volume-action icons and the dial's fallback tile are a
  hand-drawn music-note glyph on a red tile (drawn with Core Graphics — not
  Apple's logo, not an SF Symbol).
- The playback glyphs (play, next, shuffle, …) are macOS **SF Symbols** rendered
  onto our own tile.

The **genuine Apple Music icon** you see on the dial touchscreen is read from the
**Music.app installed on your own machine at runtime** and handed to the plugin
as an in-memory `data:` URI — it is never written to disk or included in the
distributed `.streamDeckPlugin`. If Music.app (or its icon) isn't available, the
dial falls back to the bundled original tile.

> **Trademark disclaimer.** Apple Music is a trademark of Apple Inc. This project
> is independent and is not affiliated with, authorized, sponsored, or endorsed
> by Apple.

## Architecture

A dial emits many `dialRotate` events per second, and the only way to set Music's
volume on macOS is an Apple Event. Spawning `osascript` per tick would add
30–80 ms of process-startup latency each time. Instead, the Node plugin spawns a
single persistent Swift helper (`bin/music-volume`) that holds one warm
`SBApplication` connection for its whole lifetime — each command is a
sub-millisecond in-process Apple Event with no per-tick spawn. Rapid rotations
are coalesced (latest-wins, ~40 ms).

```
Stream Deck app ──WebSocket──> bin/plugin.js  (Node, @elgato/streamdeck)
                                   │  spawns once, talks over stdin/stdout
                                   ▼
                          bin/music-volume    (Swift, ScriptingBridge + AppKit)
                                   │  warm Apple Event  /  NSWorkspace icon read
                                   ▼
                              Music.app
```

### Helper protocol (stdin → stdout, line-delimited)

Commands:

| Command | Meaning |
| --- | --- |
| `v <0-100>` | set sound volume |
| `m` / `m 1` / `m 0` | toggle / force mute |
| `g` | query volume state |
| `pp` | play / pause toggle |
| `next` / `prev` | skip / previous track |
| `love` / `love 1` / `love 0` | toggle / force favorite on the current track |
| `shuffle` / `shuffle 1` / `shuffle 0` | toggle / force shuffle |
| `repeat` / `repeat 0\|1\|2` | cycle / set repeat (0 off, 1 all, 2 one) |
| `s` | query full playback status |
| `art` | reply `art <trackId> <base64png>` (144px) or `art <trackId> none` |
| `meta` | reply `meta <trackId> <name>\t<artist>\t<album>` or `meta <trackId> none` |
| `appicon` / `appicon muted` | reply `appicon <0\|1> <base64png>` (144px, the live Music.app icon) or `appicon <0\|1> none` |

Replies:

- Volume commands (`v` / `m` / `g`): `state <volume> <mute 0|1> <running 0|1>`
- Playback commands (`pp` / `next` / `prev` / `love` / `shuffle` / `repeat` / `s`):
  `status <volume> <mute 0|1> <running 0|1> <playing 0|1|2> <fav 0|1> <shuffle 0|1> <repeat 0|1|2> <trackId>`
  (`playing`: 0 stopped, 1 playing, 2 paused)
- A `state -1 …` / `status -1 …` reply signals a missing Automation (TCC) permission.

## Install

### From a release

1. Download the latest `.streamDeckPlugin` from the
   [Releases](../../releases) page.
2. Double-click it; the Stream Deck app installs it.
3. Drag any **Apple Music** action onto a key or dial.

The first command triggers a one-time macOS **Automation** prompt
("… wants to control Music") — approve it so the plugin can talk to Music.app.
(If you miss it: System Settings → Privacy & Security → Automation.)

### Local development

```bash
npm install
npm run build          # bundle src → com.timeraa.apple-music-volume.sdPlugin/bin/plugin.js
npm run build:native   # compile the universal (arm64 + x86_64) Swift helper → bin/music-volume

npm i -g @elgato/cli
streamdeck link com.timeraa.apple-music-volume.sdPlugin
streamdeck restart com.timeraa.apple-music-volume
```

> If you link the plugin while the Stream Deck app is already running, fully quit
> and relaunch the app once so it scans the new plugin — `restart <uuid>` only
> restarts an already-loaded plugin.

`npm run check` runs formatting, linting, and `tsc --noEmit`.

### Regenerating the artwork

All committed PNGs are reproducible from source (original brand art + SF-Symbol
glyphs on a tile). They are checked in, so neither CI nor end users need to run this:

```bash
native/make-art.sh
```

## Continuous integration / releases

`.github/workflows/release.yml` runs on `macos-latest` (it needs `swiftc` and
Xcode, both preinstalled):

- **Every push / PR:** `npm ci` → `npm run build` → `npm run build:native` →
  `streamdeck validate`. Icons are committed, so CI never generates art and needs
  no Music.app.
- **On a `v*` tag:** the SemVer tag `v1.2.3` is mapped to Stream Deck's four-part
  `1.2.3.0`, the plugin is packed with `streamdeck pack`, and the resulting
  `.streamDeckPlugin` is uploaded as a build artifact and attached to a GitHub
  Release.

## License

[MIT](./LICENSE) © timeraa.
