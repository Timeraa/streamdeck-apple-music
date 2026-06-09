// music-volume — persistent ScriptingBridge helper for Apple Music output volume.
//
// Reads newline-delimited commands on stdin and emits `state` lines on stdout.
// One warm SBApplication connection is held for the whole process lifetime, so
// each volume write is a sub-millisecond in-process Apple Event — no per-tick
// `osascript` spawn.
//
// Protocol (stdin -> stdout, line-delimited):
//   v <0-100>     set sound volume
//   m | m 1 | m 0 toggle / force mute
//   g             query volume state
//   pp            play/pause toggle
//   next | prev   skip / previous track
//   love | love 1 | love 0   toggle / force "favorited" on the current track
//   shuffle | shuffle 1 | shuffle 0   toggle / force shuffle
//   repeat | repeat 0|1|2   cycle / set repeat (0 off, 1 all, 2 one)
//   s             query full playback status
//   art           reply `art <trackId> <base64png>` (144px) or `art <trackId> none`
//   meta          reply `meta <trackId> <name>\t<artist>\t<album>` or `meta <trackId> none`
//   appicon | appicon muted   reply `appicon <0|1> <base64png>` (144px, read live from
//                 the installed Music.app; 0|1 = normal|muted variant) or `appicon <0|1> none`
//
// Volume commands (v/m/g) reply with:  state <volume> <mute 0|1> <running 0|1>
// Playback commands (pp/next/prev/love/shuffle/repeat/s) reply with:
//   status <volume> <mute 0|1> <running 0|1> <playing 0|1|2> <fav 0|1> <shuffle 0|1> <repeat 0|1|2>
//   (playing: 0 stopped, 1 playing, 2 paused;  repeat: 0 off, 1 all, 2 one)
// On an Automation (TCC) authorization failure: state -1 0 0  /  status -1 0 0 0 0 0 0

import AppKit
import Foundation
import ScriptingBridge

// Minimal bridge to the bits of the Music scripting interface we use. Getters
// are optional vars; setters are optional methods — this mirrors what
// `sdp -fh` generates from Music's sdef and is the form Swift allows for
// `@objc optional` members. The empty extension makes SBApplication formally
// conform so its dynamic message forwarding handles the calls at runtime.
@objc protocol MusicApplication {
    @objc optional var soundVolume: Int { get }
    @objc optional func setSoundVolume(_ value: Int)
    @objc optional var playerState: Int { get }
    @objc optional var shuffleEnabled: Bool { get }
    @objc optional func setShuffleEnabled(_ value: Bool)
    @objc optional var songRepeat: Int { get }
    @objc optional func setSongRepeat(_ value: Int)
    @objc optional var currentTrack: SBObject { get }
    @objc optional func playpause()
    @objc optional func nextTrack()
    @objc optional func previousTrack()
}
extension SBApplication: MusicApplication {}

// FourCharCode raw values of the scripting enums (verified against Music's sdef).
let psPlaying = 1800426320  // kPSP
let psPaused = 1800426352   // kPSp
let rpOff = 1800564815      // kRpO
let rpOne = 1800564785      // kRp1
let rpAll = 1799449708      // kAll

let bundleID = "com.apple.Music"

// Held warm for the lifetime of the process.
let music: MusicApplication? = SBApplication(bundleIdentifier: bundleID)

// Mute is implemented by saving the current volume and setting it to 0, then
// restoring on unmute. Music's native `mute` property throws (error 9038) when
// nothing is playing, so it can't drive an always-responsive dial. `nil` means
// not muted; otherwise it holds the pre-mute volume to restore.
var savedVolume: Int? = nil
func isMuted() -> Bool { return savedVolume != nil }

/// Is Music currently running? We never force-launch it.
func musicRunning() -> Bool {
    return !NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty
}

/// Recognize the macOS Automation (TCC) authorization error codes.
func isAuthError(_ err: NSError) -> Bool {
    // errAEEventNotPermitted (-1743), procNotFound (-600), errAEEventFailed (-10000) family.
    return err.code == -1743 || err.code == -10004 || err.code == -600
}

/// Did the last Apple Event fail with an authorization error?
func lastWasAuthError() -> Bool {
    if let err = (music as? SBApplication)?.lastError() as NSError?, isAuthError(err) {
        return true
    }
    return false
}

/// Emit current state. `auth == false` signals an Automation permission failure.
func emitState(auth: Bool = true) {
    guard auth else {
        print("state -1 0 0")
        return
    }
    guard musicRunning(), let app = music else {
        print("state 0 0 0")
        return
    }
    let vol = app.soundVolume ?? 0
    if lastWasAuthError() {
        print("state -1 0 0")
        return
    }
    let muted = isMuted() ? 1 : 0
    print("state \(vol) \(muted) 1")
}

/// Run a closure that touches Music; report auth failures via state.
func withAuthCheck(_ body: () -> Void) {
    body()
    if lastWasAuthError() {
        emitState(auth: false)
    } else {
        emitState()
    }
}

/// Emit full playback status. `auth == false` signals a permission failure.
func emitStatus(auth: Bool = true) {
    guard auth else {
        print("status -1 0 0 0 0 0 0 -")
        return
    }
    guard musicRunning(), let app = music else {
        print("status 0 0 0 0 0 0 0 -")
        return
    }
    let vol = app.soundVolume ?? 0
    if lastWasAuthError() {
        print("status -1 0 0 0 0 0 0 -")
        return
    }
    let muted = isMuted() ? 1 : 0
    let ps = app.playerState ?? 0
    let playing = ps == psPlaying ? 1 : (ps == psPaused ? 2 : 0)
    let shuffle = (app.shuffleEnabled ?? false) ? 1 : 0
    let rep = app.songRepeat ?? rpOff
    let repeatV = rep == rpAll ? 1 : (rep == rpOne ? 2 : 0)
    var fav = 0
    var trackID = "-"
    if let track = app.currentTrack {
        if let f = track.value(forKey: "favorited") as? Bool { fav = f ? 1 : 0 }
        if let pid = track.value(forKey: "persistentID") as? String, !pid.isEmpty {
            trackID = pid
        }
    }
    print("status \(vol) \(muted) 1 \(playing) \(fav) \(shuffle) \(repeatV) \(trackID)")
}

/// Base64-encoded PNG of `track`'s artwork, downscaled to 144×144. Takes the
/// track explicitly so the caller reads `persistentID` and `artworks` from the
/// same snapshot (a skip mid-read must not mismatch the two).
func artworkBase64(_ track: SBObject) -> String? {
    guard let arts = track.value(forKey: "artworks") as? SBElementArray, arts.count > 0 else {
        return nil
    }
    guard let art = arts.object(at: 0) as? SBObject else { return nil }

    let raw = art.value(forKey: "data")
    var image: NSImage?
    if let img = raw as? NSImage {
        image = img
    } else if let desc = raw as? NSAppleEventDescriptor, let d = desc.data as Data? {
        image = NSImage(data: d)
    }
    guard let source = image, source.size.width > 0 else { return nil }

    let side = 144
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    source.draw(
        in: CGRect(x: 0, y: 0, width: side, height: side),
        from: NSRect(origin: .zero, size: source.size),
        operation: .copy, fraction: 1.0)
    NSGraphicsContext.restoreGraphicsState()

    guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
    return png.base64EncodedString()
}

/// Tab-delimited "name\tartist\talbum" for `track`, or nil when it has no usable
/// name/artist. Used by the plugin to look up cover art online for catalog
/// tracks that aren't in the library (whose `artworks` is empty). Takes the
/// track explicitly so the caller pairs it with the same snapshot's id.
func trackMeta(_ track: SBObject) -> String? {
    let name = (track.value(forKey: "name") as? String) ?? ""
    let artist = (track.value(forKey: "artist") as? String) ?? ""
    let album = (track.value(forKey: "album") as? String) ?? ""
    if name.isEmpty && artist.isEmpty { return nil }
    // Strip tabs/newlines so the single-line, tab-delimited framing holds.
    func clean(_ s: String) -> String {
        return s.replacingOccurrences(of: "\t", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
    }
    return "\(clean(name))\t\(clean(artist))\t\(clean(album))"
}

/// Base64 PNG (144×144) of the installed Music.app icon, optionally with the
/// muted stripe overlaid. The genuine Apple Music artwork is read live from the
/// user's own machine and handed to the plugin for display on the dial only — it
/// is never written to disk or bundled. Returns nil when Music.app (or its icon)
/// is unavailable, so the plugin can fall back to its own bundled art.
func appIconBase64(muted: Bool) -> String? {
    let candidates = ["/System/Applications/Music.app", "/Applications/Music.app"]
    guard let musicPath = candidates.first(where: { FileManager.default.fileExists(atPath: $0) })
    else { return nil }
    let appIcon = NSWorkspace.shared.icon(forFile: musicPath)
    guard appIcon.size.width > 0 else { return nil }

    let side = 144
    let dim = CGFloat(side)
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let full = NSRect(x: 0, y: 0, width: dim, height: dim)
    NSGraphicsContext.current!.cgContext.clear(full)
    appIcon.draw(in: full, from: .zero, operation: .sourceOver, fraction: 1.0)

    if muted {
        // Thin diagonal stripe (black casing under a red bar) so it reads clearly
        // against any part of the artwork. Matches the bundled fallback's stripe.
        let p1 = NSPoint(x: dim * 0.18, y: dim * 0.18)
        let p2 = NSPoint(x: dim * 0.82, y: dim * 0.82)
        let casing = NSBezierPath()
        casing.move(to: p1)
        casing.line(to: p2)
        casing.lineWidth = dim * 0.115
        casing.lineCapStyle = .round
        NSColor.black.setStroke()
        casing.stroke()
        let bar = NSBezierPath()
        bar.move(to: p1)
        bar.line(to: p2)
        bar.lineWidth = dim * 0.07
        bar.lineCapStyle = .round
        NSColor(srgbRed: 0.98, green: 0.14, blue: 0.24, alpha: 1.0).setStroke()
        bar.stroke()
    }

    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
    return png.base64EncodedString()
}

/// Run a closure that touches Music; report auth failures via status.
func withStatusCheck(_ body: () -> Void) {
    body()
    if lastWasAuthError() {
        emitStatus(auth: false)
    } else {
        emitStatus()
    }
}

func handle(_ line: String) {
    let parts = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
    guard let cmd = parts.first else { return }

    switch cmd {
    case "v":
        guard parts.count >= 2, let raw = Int(parts[1]) else { emitState(); return }
        let clamped = max(0, min(100, raw))
        guard musicRunning(), let app = music else { emitState(); return }
        // An explicit volume change cancels any active mute.
        savedVolume = nil
        withAuthCheck { app.setSoundVolume?(clamped) }

    case "m":
        guard musicRunning(), let app = music else { emitState(); return }
        let target: Bool
        if parts.count >= 2, let forced = Int(parts[1]) {
            target = forced != 0
        } else {
            target = !isMuted()
        }
        if target {
            // Mute: remember current volume once, then drop to 0.
            if savedVolume == nil {
                savedVolume = app.soundVolume ?? 0
                withAuthCheck { app.setSoundVolume?(0) }
            } else {
                emitState()
            }
        } else {
            // Unmute: restore the saved volume.
            if let restore = savedVolume {
                savedVolume = nil
                withAuthCheck { app.setSoundVolume?(restore) }
            } else {
                emitState()
            }
        }

    case "g":
        emitState()

    case "s":
        emitStatus()

    case "art":
        // Reply `art <trackId> <base64png|none>` so the plugin can drop art
        // for a track it has already skipped past (the bytes carry no id of
        // their own). `art - none` when there's no current track.
        if musicRunning(), let app = music, let track = app.currentTrack {
            let tid = (track.value(forKey: "persistentID") as? String) ?? "-"
            if let b64 = artworkBase64(track) {
                print("art \(tid) \(b64)")
            } else {
                print("art \(tid) none")
            }
        } else {
            print("art - none")
        }

    case "meta":
        // Reply `meta <trackId> <name>\t<artist>\t<album>` or `meta <trackId> none`.
        if musicRunning(), let app = music, let track = app.currentTrack {
            let tid = (track.value(forKey: "persistentID") as? String) ?? "-"
            if let m = trackMeta(track) {
                print("meta \(tid) \(m)")
            } else {
                print("meta \(tid) none")
            }
        } else {
            print("meta - none")
        }

    case "appicon":
        // Reply `appicon <0|1> <base64png|none>`; the 0|1 echoes which variant
        // (normal / muted) was requested so the plugin caches it correctly. The
        // icon is read live from the installed Music.app and never bundled.
        let wantMuted = parts.count >= 2 && parts[1] == "muted"
        let variant = wantMuted ? 1 : 0
        if let b64 = appIconBase64(muted: wantMuted) {
            print("appicon \(variant) \(b64)")
        } else {
            print("appicon \(variant) none")
        }

    case "pp":
        guard musicRunning(), let app = music else { emitStatus(); return }
        withStatusCheck { app.playpause?() }

    case "next":
        guard musicRunning(), let app = music else { emitStatus(); return }
        withStatusCheck { app.nextTrack?() }

    case "prev":
        guard musicRunning(), let app = music else { emitStatus(); return }
        withStatusCheck { app.previousTrack?() }

    case "love":
        guard musicRunning(), let app = music, let track = app.currentTrack else {
            emitStatus(); return
        }
        let current = (track.value(forKey: "favorited") as? Bool) ?? false
        let target: Bool
        if parts.count >= 2, let forced = Int(parts[1]) {
            target = forced != 0
        } else {
            target = !current
        }
        withStatusCheck { track.setValue(target, forKey: "favorited") }

    case "shuffle":
        guard musicRunning(), let app = music else { emitStatus(); return }
        let current = app.shuffleEnabled ?? false
        let target: Bool
        if parts.count >= 2, let forced = Int(parts[1]) {
            target = forced != 0
        } else {
            target = !current
        }
        withStatusCheck { app.setShuffleEnabled?(target) }

    case "repeat":
        guard musicRunning(), let app = music else { emitStatus(); return }
        let mode: Int
        if parts.count >= 2, let forced = Int(parts[1]) {
            mode = max(0, min(2, forced))
        } else {
            // Cycle off -> all -> one -> off.
            let rep = app.songRepeat ?? rpOff
            let cur = rep == rpAll ? 1 : (rep == rpOne ? 2 : 0)
            mode = (cur + 1) % 3
        }
        let code = mode == 1 ? rpAll : (mode == 2 ? rpOne : rpOff)
        withStatusCheck { app.setSongRepeat?(code) }

    default:
        emitState()
    }
}

// Make stdout unbuffered so Node sees each `state` line promptly.
setbuf(stdout, nil)

// Read stdin line by line until EOF (parent closes the pipe / exits).
while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { continue }
    handle(trimmed)
}
