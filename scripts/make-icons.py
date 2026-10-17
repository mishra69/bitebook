#!/usr/bin/env python3
"""Generate Bitebook's icons as PNGs with no third-party deps.

A plate (rim + well) with a bite taken out of its upper right, on dark green.
Adapted from the pwa-cloudflare skill's make-icons.py: backgrounds are opaque
(iOS renders alpha as black), corners are square (iOS applies its own mask),
and the apple-touch and maskable sizes are padded harder.

Run from the repo root: python3 scripts/make-icons.py
"""
import os
import struct
import zlib

BG = (31, 42, 31)
PLATE = (247, 245, 240)
RIM = (214, 208, 196)
OUT = os.path.join(os.getcwd(), "public", "icons")


def png(path, size, rows):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def draw(size, pad_frac):
    """Content fills the square minus pad_frac on each side."""
    ss = 4  # supersampling per axis, for smooth circle edges
    c = size / 2
    r_plate = size * (0.5 - pad_frac)
    r_rim_out, r_rim_in = r_plate * 0.70, r_plate * 0.64
    bite_cx, bite_cy, bite_r = c + r_plate * 0.78, c - r_plate * 0.78, r_plate * 0.42

    def color_at(x, y):
        dx, dy = x - c, y - c
        d2 = dx * dx + dy * dy
        if d2 > r_plate * r_plate:
            return BG
        bx, by = x - bite_cx, y - bite_cy
        if bx * bx + by * by < bite_r * bite_r:
            return BG
        if r_rim_in * r_rim_in <= d2 <= r_rim_out * r_rim_out:
            return RIM
        return PLATE

    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    col = color_at(px + (sx + 0.5) / ss, py + (sy + 0.5) / ss)
                    acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]
            n = ss * ss
            row += bytes((acc[0] // n, acc[1] // n, acc[2] // n))
        rows.append(row)
    return rows


os.makedirs(OUT, exist_ok=True)
for name, size, pad in [
    ("apple-touch-icon.png", 180, 0.12),  # iOS squircle-crops the corners
    ("icon-192.png", 192, 0.10),
    ("icon-512.png", 512, 0.10),
    ("icon-maskable-512.png", 512, 0.20),  # safe zone is the middle 80%
]:
    png(os.path.join(OUT, name), size, draw(size, pad))
    print(name, os.path.getsize(os.path.join(OUT, name)), "bytes")
