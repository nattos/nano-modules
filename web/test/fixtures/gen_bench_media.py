#!/usr/bin/env python3
"""
Generate the varied-codec test media for the video-provider stall benchmark
(test/video-stall-benchmark.test.ts).

Writes short, visually-distinct clips spanning the codecs headless Chromium can
actually decode through the arrangement's <video> cursor path (H.264, VP8, VP9),
plus a long-GOP / single-keyframe H.264 (exercises the #117 path) and a 1080p60
stress clip. DXV (.mov) and a still image are NOT generated here — they ride the
service FrameSource path and already exist under public/media/.

Output goes to web/public/test-videos/bench/ (gitignored), alongside a
manifest.json the benchmark reads for each clip's {file, codec, fps, frames,
w, h}. Idempotent: skips a file that already exists unless --force.

Usage:
    python3 test/fixtures/gen_bench_media.py [--force]

Requires ffmpeg on PATH (brew install ffmpeg).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "public", "test-videos", "bench"))

# Each clip: a distinct ffmpeg test-source pattern so they're easy to tell apart
# on screen, encoded with broadly-compatible yuv420p. `extra` are codec-specific
# flags. `frames` = fps * dur (kept exact so the store's durationFrames is right).
CLIPS = [
    # name, codec label, container, video filter source, w, h, fps, dur(s), encoder, extra
    ("bench_h264_720p30",   "h264", "mp4",  "testsrc2",    1280, 720, 30, 5, "libx264",     ["-pix_fmt", "yuv420p", "-g", "30"]),
    ("bench_h264_1080p60",  "h264", "mp4",  "mandelbrot",  1920, 1080, 60, 5, "libx264",    ["-pix_fmt", "yuv420p", "-g", "60", "-preset", "veryfast"]),
    ("bench_h264_longgop",  "h264", "mp4",  "smptebars",   1280, 720, 30, 5, "libx264",     ["-pix_fmt", "yuv420p", "-g", "9999", "-keyint_min", "9999"]),
    ("bench_vp9_720p30",    "vp9",  "webm", "rgbtestsrc",  1280, 720, 30, 5, "libvpx-vp9",  ["-pix_fmt", "yuv420p", "-b:v", "1M", "-deadline", "realtime", "-cpu-used", "8"]),
    ("bench_vp8_480p30",    "vp8",  "webm", "testsrc",     854, 480, 30, 5, "libvpx",       ["-pix_fmt", "yuv420p", "-b:v", "1M", "-deadline", "realtime", "-cpu-used", "8"]),
]


def gen(force: bool) -> None:
    ff = shutil.which("ffmpeg")
    if not ff:
        sys.exit("ffmpeg not found on PATH (brew install ffmpeg)")
    os.makedirs(OUT_DIR, exist_ok=True)

    manifest = []
    for name, codec, container, src, w, h, fps, dur, enc, extra in CLIPS:
        fname = f"{name}.{container}"
        path = os.path.join(OUT_DIR, fname)
        frames = fps * dur
        entry = {"file": fname, "codec": codec, "fps": fps, "frames": frames, "w": w, "h": h}
        manifest.append(entry)
        if os.path.exists(path) and not force:
            print(f"  skip  {fname} (exists)")
            continue
        # `-t` caps duration universally (some lavfi sources — mandelbrot,
        # rgbtestsrc — don't accept a `duration=` option, unlike testsrc).
        cmd = [
            ff, "-y", "-f", "lavfi",
            "-i", f"{src}=size={w}x{h}:rate={fps}",
            "-t", str(dur), "-c:v", enc, *extra, "-an", path,
        ]
        print(f"  gen   {fname}  ({enc} {w}x{h}@{fps} {dur}s, {frames}f)")
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"manifest → {os.path.join(OUT_DIR, 'manifest.json')} ({len(manifest)} clips)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="regenerate existing files")
    gen(ap.parse_args().force)
