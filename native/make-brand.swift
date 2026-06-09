// Build-time brand-art generator (not shipped). Renders the plugin/action brand
// icons as a red rounded gradient tile with a HAND-DRAWN, ORIGINAL eighth-note
// glyph — deliberately not Apple's logo and not an SF Symbol, so the bundled /
// redistributed package contains no Apple intellectual property. An optional
// `muted` argument overlays the diagonal stripe used for the dial's muted state.
//
// Usage: make-brand <out.png> <size> [muted]
//
// The tile gradient + geometry mirror native/make-symbols.swift so the brand art
// sits visually alongside the SF-Symbol playback glyphs. (Color is not
// protectable; the note path below is our own drawing.)
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count >= 3, let size = Int(args[2]) else {
    FileHandle.standardError.write("usage: make-brand <out.png> <size> [muted]\n".data(using: .utf8)!)
    exit(1)
}
let outPath = args[1]
let dim = CGFloat(size)
let muted = args.count >= 4 && args[3] == "muted"

// Apple Music red gradient (top -> bottom), matching make-symbols' "red" tile.
let top = NSColor(srgbRed: 0.99, green: 0.36, blue: 0.46, alpha: 1.0)
let bottom = NSColor(srgbRed: 0.96, green: 0.11, blue: 0.27, alpha: 1.0)

/// Our own eighth-note glyph (note head + stem + flag), drawn white, sized and
/// centred for a `dim`×`dim` canvas. Each part is filled separately so the union
/// is solid regardless of sub-path winding.
func drawNote(_ dim: CGFloat) {
    NSColor.white.setFill()

    // Stem: a rounded vertical bar on the right of the note head.
    let stemW = dim * 0.042
    let stemRightX = dim * 0.545
    let stemX = stemRightX - stemW
    let stemBottomY = dim * 0.360
    let stemTopY = dim * 0.745
    let stem = NSBezierPath(
        roundedRect: NSRect(x: stemX, y: stemBottomY, width: stemW, height: stemTopY - stemBottomY),
        xRadius: stemW * 0.5, yRadius: stemW * 0.5)
    stem.fill()

    // Flag: a teardrop hook sweeping off the top-right of the stem.
    let flag = NSBezierPath()
    flag.move(to: NSPoint(x: stemX, y: stemTopY))
    flag.curve(
        to: NSPoint(x: dim * 0.610, y: dim * 0.520),
        controlPoint1: NSPoint(x: dim * 0.690, y: dim * 0.730),
        controlPoint2: NSPoint(x: dim * 0.705, y: dim * 0.585))
    flag.curve(
        to: NSPoint(x: stemRightX, y: dim * 0.605),
        controlPoint1: NSPoint(x: dim * 0.635, y: dim * 0.560),
        controlPoint2: NSPoint(x: dim * 0.595, y: dim * 0.585))
    flag.line(to: NSPoint(x: stemX, y: stemTopY))
    flag.close()
    flag.fill()

    // Note head: a tilted ellipse rotated about its own centre.
    let headW = dim * 0.235
    let headH = dim * 0.172
    let headCX = dim * 0.430
    let headCY = dim * 0.358
    let head = NSBezierPath(
        ovalIn: NSRect(x: headCX - headW / 2, y: headCY - headH / 2, width: headW, height: headH))
    let rot = NSAffineTransform()
    rot.translateX(by: headCX, yBy: headCY)
    rot.rotate(byDegrees: -24)
    rot.translateX(by: -headCX, yBy: -headCY)
    head.transform(using: rot as AffineTransform)
    head.fill()
}

let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current!.cgContext.clear(CGRect(x: 0, y: 0, width: dim, height: dim))

// Rounded tile filling most of the canvas, with a small margin like first-party
// keys (geometry shared with make-symbols.swift).
let inset = dim * 0.085
let tileRect = NSRect(x: inset, y: inset, width: dim - inset * 2, height: dim - inset * 2)
let radius = dim * 0.235
let tile = NSBezierPath(roundedRect: tileRect, xRadius: radius, yRadius: radius)
if let grad = NSGradient(starting: top, ending: bottom) {
    grad.draw(in: tile, angle: -90)
}
// Subtle top highlight for depth.
NSColor(white: 1.0, alpha: 0.12).setStroke()
let hl = NSBezierPath(
    roundedRect: tileRect.insetBy(dx: dim * 0.02, dy: dim * 0.02),
    xRadius: radius * 0.85, yRadius: radius * 0.85)
hl.lineWidth = dim * 0.012
hl.stroke()

// Our original note glyph.
drawNote(dim)

if muted {
    // Thin diagonal stripe (black casing under a red bar) marking the muted
    // state — same treatment used on the live dial icon.
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

guard let data = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("failed to encode png\n".data(using: .utf8)!)
    exit(1)
}
try data.write(to: URL(fileURLWithPath: outPath))
