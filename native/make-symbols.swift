// Build-time icon generator (not shipped). Renders an SF Symbol centered on a
// rounded gradient tile, matching the polished look of first-party Stream Deck
// keys. Usage: make-symbols <out.png> <size> <symbol> <tile>
// tile: red (active / Apple Music) | gray (inactive toggle)
import AppKit
import Foundation

let args = CommandLine.arguments
guard args.count >= 5, let size = Int(args[2]) else {
    FileHandle.standardError.write("usage: make-symbols <out.png> <size> <symbol> <red|gray>\n".data(using: .utf8)!)
    exit(1)
}
let outPath = args[1]
let dim = CGFloat(size)
let symbolName = args[3]

// Tile gradient (top -> bottom).
let top: NSColor
let bottom: NSColor
switch args[4] {
case "gray":
    top = NSColor(srgbRed: 0.36, green: 0.36, blue: 0.40, alpha: 1.0)
    bottom = NSColor(srgbRed: 0.20, green: 0.20, blue: 0.23, alpha: 1.0)
default: // red — Apple Music
    top = NSColor(srgbRed: 0.99, green: 0.36, blue: 0.46, alpha: 1.0)
    bottom = NSColor(srgbRed: 0.96, green: 0.11, blue: 0.27, alpha: 1.0)
}

let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current!.cgContext.clear(CGRect(x: 0, y: 0, width: dim, height: dim))

// Rounded tile filling most of the key, with a small margin like first-party keys.
let inset = dim * 0.085
let tileRect = NSRect(x: inset, y: inset, width: dim - inset * 2, height: dim - inset * 2)
let radius = dim * 0.235
let tile = NSBezierPath(roundedRect: tileRect, xRadius: radius, yRadius: radius)
if let grad = NSGradient(starting: top, ending: bottom) {
    grad.draw(in: tile, angle: -90)
}
// Subtle top highlight for depth.
NSColor(white: 1.0, alpha: 0.12).setStroke()
let hl = NSBezierPath(roundedRect: tileRect.insetBy(dx: dim * 0.02, dy: dim * 0.02),
                      xRadius: radius * 0.85, yRadius: radius * 0.85)
hl.lineWidth = dim * 0.012
hl.stroke()

// White glyph centered, fit within ~52% of the canvas.
let glyphCfg = NSImage.SymbolConfiguration(pointSize: dim * 0.42, weight: .semibold)
    .applying(NSImage.SymbolConfiguration(paletteColors: [.white]))
if let glyph = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)?
    .withSymbolConfiguration(glyphCfg) {
    let box = dim * 0.5
    let gs = glyph.size
    let scale = min(box / gs.width, box / gs.height)
    let w = gs.width * scale
    let h = gs.height * scale
    glyph.draw(
        in: CGRect(x: (dim - w) / 2, y: (dim - h) / 2, width: w, height: h),
        from: .zero, operation: .sourceOver, fraction: 1.0)
} else {
    FileHandle.standardError.write("unknown symbol: \(symbolName)\n".data(using: .utf8)!)
    exit(1)
}

NSGraphicsContext.restoreGraphicsState()

guard let data = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("failed to encode png\n".data(using: .utf8)!)
    exit(1)
}
try data.write(to: URL(fileURLWithPath: outPath))
