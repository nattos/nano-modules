#!/usr/bin/env python3
"""
Bake the LUT 2 (-> "LUT Collection 1") preset strips into a C++ header.

The shipped Resolume Wire "LUT 2" patch applies each preset via the ISF
`LUTShader` — a 64x64x64 colour cube packed into a 512x512 PNG as an 8x8 grid
of 64x64 tiles (blue selects the tile, red/green index within it; trilinear
across the two adjacent blue tiles). See LUTShader.isf.

This script replays that exact strip addressing to resample each preset onto a
LUT_DIM^3 grid and emits `lut_data.h`:
    LUT_DIM, LUT_COUNT, LUT_NAMES[], LUT_DATA[]   (RGBA8, x + y*N + z*N*N order)

A real 3D texture + hardware trilinear at runtime is far cheaper than the
original's hand-rolled 8x8 strip math (the team's "implement more efficiently"
ask). LUT_DIM=32 is a deliberate downsample of the 64^3 source: these are smooth
global grades, and 32^3 trilinear-upsampled is visually indistinguishable while
keeping the baked table at ~1.7 MB total instead of ~13.6 MB. Re-run with a
larger LUT_DIM if a preset ever shows banding.

The header is committed — the build does NOT depend on the Google Drive source
path. Re-run this only to regenerate (e.g. add/reorder presets).

Usage:  python3 gen_lut_data.py [src_image_dir]
"""
import os, sys, math
from PIL import Image

LUT_DIM = 32

# (display name, lookup-<file>.png)  — order is the selectField option order.
# All 13 baked presets from the patch's Resource/Image are included (the live
# patch wired 10 of these into its switch; keeping all 13 is strictly more
# useful and the team is happy to keep the baked resources as-is).
PRESETS = [
    ("Process",                 "lookup-process.png"),
    ("Instant",                 "lookup-instant.png"),
    ("Fade",                    "lookup-fade.png"),
    ("Chrome",                  "lookup-chrome.png"),
    ("Transfer",                "lookup-transfer.png"),
    ("Tonal",                   "lookup-tonal.png"),
    ("Mono",                    "lookup-mono.png"),
    ("Noir",                    "lookup-noir.png"),
    ("Saturation + Contrast",   "lookup-saturation+contrast.png"),
    ("Saturation/Contrast (More)", "lookup-saturation-contrast-more.png"),
    ("Hue Rotate 90",           "lookup-rotate-90.png"),
    ("Hue Rotate 180",          "lookup-rotate-180.png"),
    ("Hue Rotate 270",          "lookup-rotate-270.png"),
]

DEFAULT_SRC = os.path.expanduser(
    "~/Library/CloudStorage/GoogleDrive-natnyo@gmail.com/My Drive/Resolume/Wire/Patches/LUT 2/Resource/Image"
)


def sample_bilinear(px, W, H, u, v):
    """Bilinear sample of a top-origin RGB image at normalized (u,v) in [0,1]."""
    fx = min(max(u, 0.0), 1.0) * (W - 1)
    fy = min(max(v, 0.0), 1.0) * (H - 1)
    x0 = int(math.floor(fx)); y0 = int(math.floor(fy))
    x1 = min(x0 + 1, W - 1);  y1 = min(y0 + 1, H - 1)
    tx = fx - x0; ty = fy - y0
    def g(x, y):
        return px[y * W + x]
    c00 = g(x0, y0); c10 = g(x1, y0); c01 = g(x0, y1); c11 = g(x1, y1)
    out = []
    for k in range(3):
        a = c00[k] * (1 - tx) + c10[k] * tx
        b = c01[k] * (1 - tx) + c11[k] * tx
        out.append(a * (1 - ty) + b * ty)
    return out


def isf_lookup(px, W, H, r, g, b):
    """Replicate LUTShader.isf addressing: 64^3 cube in an 8x8 grid of 64x64.

    The shader's unconditional `texPos.y = 1 - texPos.y` cancels the GL
    bottom-origin vs file top-origin flip, so sampling the top-origin PIL
    image directly at (tx, ty) is the faithful result.
    """
    blue = b * 63.0
    lo = int(math.floor(blue)); hi = int(math.ceil(blue)); frac = blue - lo

    def tile(bidx):
        bidx = min(max(bidx, 0), 63)
        qy = math.floor(bidx / 8.0)
        qx = bidx - qy * 8.0
        tx = (qx * 0.125) + 0.5 / W + ((0.125 - 1.0 / W) * r)
        ty = (qy * 0.125) + 0.5 / H + ((0.125 - 1.0 / H) * g)
        return sample_bilinear(px, W, H, tx, ty)

    c1 = tile(lo)
    c2 = tile(hi)
    return [c1[k] * (1 - frac) + c2[k] * frac for k in range(3)]


def bake_one(path):
    im = Image.open(path).convert("RGB")
    W, H = im.size
    px = list(im.getdata())
    N = LUT_DIM
    data = bytearray(N * N * N * 4)
    inv = 1.0 / (N - 1)
    for z in range(N):
        b = z * inv
        for y in range(N):
            g = y * inv
            for x in range(N):
                r = x * inv
                c = isf_lookup(px, W, H, r, g, b)
                idx = (x + y * N + z * N * N) * 4
                data[idx + 0] = int(round(min(max(c[0], 0.0), 255.0)))
                data[idx + 1] = int(round(min(max(c[1], 0.0), 255.0)))
                data[idx + 2] = int(round(min(max(c[2], 0.0), 255.0)))
                data[idx + 3] = 255
    return data


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lut_data.h")

    luts = []
    for name, fname in PRESETS:
        p = os.path.join(src, fname)
        if not os.path.exists(p):
            print(f"!! missing {p}", file=sys.stderr); sys.exit(1)
        print(f"baking {name:30s} <- {fname}")
        luts.append((name, bake_one(p)))

    # --- validation: Mono should output grayscale (R==G==B) for any input.
    for name, data in luts:
        if name == "Mono":
            N = LUT_DIM
            worst = 0
            for (x, y, z) in [(8, 24, 16), (31, 0, 7), (15, 15, 15), (4, 28, 20)]:
                idx = (x + y * N + z * N * N) * 4
                rgb = data[idx:idx + 3]
                worst = max(worst, max(rgb) - min(rgb))
            print(f"   [validate] Mono max channel spread = {worst} (expect small => addressing OK)")

    n_total = sum(len(d) for _, d in luts)
    with open(out_path, "w") as f:
        f.write("// AUTO-GENERATED by gen_lut_data.py — do not edit by hand.\n")
        f.write("// Baked LUT presets from the Resolume Wire \"LUT 2\" patch (ISF LUTShader),\n")
        f.write(f"// resampled to {LUT_DIM}^3 RGBA8 cubes. Order x + y*N + z*N*N.\n")
        f.write("#pragma once\n\n")
        f.write(f"static constexpr int LUT_DIM = {LUT_DIM};\n")
        f.write(f"static constexpr int LUT_COUNT = {len(luts)};\n")
        f.write(f"static constexpr int LUT_BYTES = {LUT_DIM*LUT_DIM*LUT_DIM*4}; // per LUT\n\n")
        names = ", ".join('"%s"' % n for n, _ in luts)
        f.write(f"static const char* const LUT_NAMES[LUT_COUNT] = {{ {names} }};\n\n")
        f.write(f"static const unsigned char LUT_DATA[{n_total}] = {{\n")
        flat = bytearray()
        for _, d in luts:
            flat += d
        line = []
        for i, byte in enumerate(flat):
            line.append(str(byte))
            if len(line) == 40:
                f.write(",".join(line) + ",\n")
                line = []
        if line:
            f.write(",".join(line) + "\n")
        f.write("};\n")
    print(f"wrote {out_path}  ({n_total} bytes, {len(luts)} LUTs)")


if __name__ == "__main__":
    main()
