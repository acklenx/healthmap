#!/usr/bin/env python3
"""Generate the PWA icon set. No image libraries needed.

The mark is a grade "A" badge -- the thing the app is actually about -- drawn
as polygons and rasterised with 3x supersampling, then written as PNG by hand.
"""

import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "public", "icons")
GREEN = (12, 163, 12)      # status "good" from the palette
WHITE = (255, 255, 255)
SS = 3                     # supersampling factor


def rounded_rect(x, y, w, h, r):
    def inside(px, py):
        if not (x <= px <= x + w and y <= py <= y + h):
            return False
        cx = min(max(px, x + r), x + w - r)
        cy = min(max(py, y + r), y + h - r)
        return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
    return inside


def polygon(points):
    def inside(px, py):
        hit = False
        n = len(points)
        for i in range(n):
            x1, y1 = points[i]
            x2, y2 = points[(i + 1) % n]
            if (y1 > py) != (y2 > py):
                xx = x1 + (py - y1) * (x2 - x1) / (y2 - y1)
                if px < xx:
                    hit = not hit
        return hit
    return inside


def letter_a(size):
    """An 'A': two tapered legs and a crossbar, sized to the canvas."""
    u = size / 100.0
    apex_x, top, bottom = 50 * u, 24 * u, 76 * u
    half, thick = 21 * u, 8.5 * u
    left = polygon([
        (apex_x - thick / 2, top), (apex_x + thick / 2, top),
        (apex_x - half + thick, bottom), (apex_x - half, bottom),
    ])
    right = polygon([
        (apex_x - thick / 2, top), (apex_x + thick / 2, top),
        (apex_x + half, bottom), (apex_x + half - thick, bottom),
    ])
    bar = polygon([
        (apex_x - 13.5 * u, 57 * u), (apex_x + 13.5 * u, 57 * u),
        (apex_x + 13.5 * u, 57 * u + thick * 0.82), (apex_x - 13.5 * u, 57 * u + thick * 0.82),
    ])
    return lambda px, py: left(px, py) or right(px, py) or bar(px, py)


def render(size, maskable=False):
    """Return RGBA rows. Maskable icons keep art inside the safe zone."""
    inset = 0 if maskable else size * 0.0
    radius = size * (0.5 if maskable else 0.22)
    plate = rounded_rect(inset, inset, size - 2 * inset, size - 2 * inset, radius)
    scale = 0.72 if maskable else 1.0     # shrink the glyph for maskable padding
    offset = size * (1 - scale) / 2
    glyph_at = letter_a(size * scale)
    glyph = lambda px, py: glyph_at(px - offset, py - offset)

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            plate_hits = glyph_hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    px = x + (sx + 0.5) / SS
                    py = y + (sy + 0.5) / SS
                    if plate(px, py):
                        plate_hits += 1
                        if glyph(px, py):
                            glyph_hits += 1
            total = SS * SS
            if not plate_hits:
                row += bytes((0, 0, 0, 0))
                continue
            t = glyph_hits / total
            base_a = int(255 * plate_hits / total)
            colour = tuple(round(GREEN[i] * (1 - t) + WHITE[i] * t) for i in range(3))
            row += bytes((*colour, base_a))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Score">
  <rect width="100" height="100" rx="22" fill="#0ca30c"/>
  <path d="M45.75 24h8.5L71 76h-9.6l-3.4-11.2H42L38.6 76H29z" fill="#fff"/>
  <path d="M44.3 57h11.4L50 38.6z" fill="#0ca30c"/>
</svg>
"""


def main():
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "icon.svg"), "w", encoding="utf-8") as fh:
        fh.write(SVG)
    for size in (192, 512):
        write_png(os.path.join(OUT, "icon-%d.png" % size), size, render(size))
        print("icon-%d.png" % size)
    write_png(os.path.join(OUT, "icon-maskable-512.png"), 512, render(512, maskable=True))
    print("icon-maskable-512.png")


if __name__ == "__main__":
    main()
