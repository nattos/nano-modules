#!/usr/bin/env python3
"""preview_sweep.py — CPU cost matrix for the barrel Live-preview path.

Wraps the (lane-connecting) `preview_bench` and sweeps the three knobs that
govern Live-mode cost — preview resolution, preview Hz, and fan-out lane count —
measuring the CPU each config actually burns. This is the headless, Resolume-free
mirror of the "Arena goes to ~280% CPU when a web client connects" symptom: the
barrel runtime is identical, only the host (a fake in-process editor) differs.

Why /usr/bin/time and not preview_bench's own `avg ms`: that column is wall-clock
on the render thread only. The real cost lives on the async readback queue and the
N fan-out lane threads (memcpy + WebSocket send). `/usr/bin/time -l` sums user+sys
CPU across ALL threads, which is the number that matches Activity Monitor.

Each config is measured twice: once with the requested preview (full cost) and
once as `baseline/anim` (render only, no client, no readback). The difference is
the CPU that Live preview *adds* on top of just rendering the composition —
i.e. the cost you'd remove by not streaming, or reduce by turning a knob.

Run from the repo root (so build/wasm resolves):
    python3 native/tools/preview_sweep.py
    python3 native/tools/preview_sweep.py --w 1920 --h 1080 --pace 60 --secs 15
    python3 native/tools/preview_sweep.py --sample        # + hotspot dump of worst case
    python3 native/tools/preview_sweep.py --only res      # just the resolution sweep
"""

import argparse
import os
import re
import subprocess
import sys
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_BIN = os.path.join(REPO, "native", "build", "preview_bench")

# preview_bench table row:  name avg p50 p95 p99 max fps | txtMsg nbpvFrm nbpvBytes
ROW_RE = re.compile(
    r"^(\S+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+\|"
    r"\s+(\d+)\s+(\d+)\s+(\d+)\s*$")
# /usr/bin/time -l summary line:  "   12.34 real   40.10 user    1.60 sys"
TIME_RE = re.compile(r"^\s*([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys")
RSS_RE = re.compile(r"^\s*(\d+)\s+maximum resident set size")


class RunResult:
    def __init__(self):
        self.real = self.user = self.sys = 0.0
        self.rss_mb = 0.0
        self.avg_ms = self.p95_ms = 0.0
        self.txt = self.nbpv = self.nbpv_bytes = 0

    @property
    def cpu_s(self):
        return self.user + self.sys


def run_bench(bin_path, W, H, scenario, preview_wh, hz, fanout, pace, frames,
              wasm_dir, port):
    """Run one preview_bench scenario under /usr/bin/time -l; parse both streams."""
    args = ["/usr/bin/time", "-l", bin_path,
            "--pace", str(pace), "--frames", str(frames),
            "--w", str(W), "--h", str(H), "--only", scenario, "--port", str(port)]
    if preview_wh:
        args += ["--preview-w", str(preview_wh[0]), "--preview-h", str(preview_wh[1])]
    env = dict(os.environ)
    env["NANO_BARREL_PREVIEW_HZ"] = str(hz)
    env["NANO_PREVIEW_FANOUT"] = str(fanout)
    if wasm_dir:
        env["NANO_BARREL_WASM_DIR"] = wasm_dir
    proc = subprocess.run(args, cwd=REPO, env=env,
                          capture_output=True, text=True)
    r = RunResult()
    for line in proc.stdout.splitlines():
        m = ROW_RE.match(line)
        if m:
            r.avg_ms = float(m.group(2)); r.p95_ms = float(m.group(4))
            r.txt = int(m.group(8)); r.nbpv = int(m.group(9))
            r.nbpv_bytes = int(m.group(10))
    for line in proc.stderr.splitlines():
        m = TIME_RE.match(line)
        if m:
            r.real, r.user, r.sys = float(m.group(1)), float(m.group(2)), float(m.group(3))
        m = RSS_RE.match(line)
        if m:
            r.rss_mb = int(m.group(1)) / 1e6
    if proc.returncode != 0 or (scenario != "baseline/anim" and r.nbpv == 0):
        sys.stderr.write(f"  ! run failed/empty ({scenario} {preview_wh} hz={hz} "
                         f"fanout={fanout}) rc={proc.returncode}\n")
        tail = "\n".join(proc.stdout.splitlines()[-3:] + proc.stderr.splitlines()[-3:])
        sys.stderr.write("    " + tail.replace("\n", "\n    ") + "\n")
    return r


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", default=DEFAULT_BIN, help="preview_bench path")
    ap.add_argument("--w", type=int, default=1920, help="composition width")
    ap.add_argument("--h", type=int, default=1080, help="composition height")
    ap.add_argument("--pace", type=float, default=60.0,
                    help="render/composition rate in fps (Resolume ~60)")
    ap.add_argument("--secs", type=float, default=12.0,
                    help="measured window per run (frames = pace*secs)")
    ap.add_argument("--wasm-dir", default="build/wasm")
    ap.add_argument("--port", type=int, default=19091)
    ap.add_argument("--only", choices=["res", "hz", "fanout", "all"], default="all")
    ap.add_argument("--sample", action="store_true",
                    help="also dump a macOS `sample` hotspot profile of the worst case")
    args = ap.parse_args()

    if not os.path.exists(args.bin):
        sys.exit(f"missing {args.bin}\n  build: (cd native && cmake --build build "
                 f"--target preview_bench)")

    W, H, pace = args.w, args.h, args.pace
    frames = int(pace * args.secs)
    window_s = frames / pace
    scen = "edit-preview/anim"   # one full-res edit preview — the Live-mode repro

    # A composition's own render CPU is the floor we subtract to isolate the
    # preview-attributable cost. It doesn't depend on preview res/hz/fanout.
    print(f"# preview_sweep: comp {W}x{H}, pace {pace}fps, {frames} frames "
          f"({window_s:.0f}s window/run), scenario {scen}")
    print(f"# baseline (render only, no client)…", flush=True)
    base = run_bench(args.bin, W, H, "baseline/anim", None, 30, 8, pace, frames,
                     args.wasm_dir, args.port)
    base_cpu = base.cpu_s
    print(f"#   render floor = {base_cpu:.2f} CPU-s  "
          f"({base_cpu/window_s*100:.0f}% avg, {base.rss_mb:.0f}MB RSS)\n")

    long_edge = max(W, H)
    def res_ladder():
        for frac in (1.0, 2/3, 1/2, 1/3, 1/6):
            yield (max(2, int(W * frac)) // 2 * 2, max(2, int(H * frac)) // 2 * 2)

    sweeps = []
    if args.only in ("res", "all"):
        sweeps.append(("preview resolution (hz=30, fanout=8)",
                       [dict(preview_wh=wh, hz=30, fanout=8) for wh in res_ladder()]))
    if args.only in ("hz", "all"):
        half = (W // 2 // 2 * 2, H // 2 // 2 * 2)
        sweeps.append((f"preview Hz ({half[0]}x{half[1]}, fanout=8)",
                       [dict(preview_wh=half, hz=hz, fanout=8) for hz in (60, 30, 15)]))
    if args.only in ("fanout", "all"):
        half = (W // 2 // 2 * 2, H // 2 // 2 * 2)
        sweeps.append((f"fan-out lanes ({half[0]}x{half[1]}, hz=30)",
                       [dict(preview_wh=half, hz=30, fanout=fo) for fo in (8, 4, 2, 1)]))

    hdr = (f"{'config':<20} {'cpu%':>6} {'Δcpu%':>7} {'cpu-ms/':>8} "
           f"{'prevFPS':>8} {'MB/s':>8} {'render':>7} {'RSS':>6}")
    sub = (f"{'':<20} {'(all)':>6} {'preview':>7} {'prevfrm':>8} "
           f"{'':>8} {'wire':>8} {'p95ms':>7} {'MB':>6}")

    for title, configs in sweeps:
        print(f"## {title}")
        print(hdr); print(sub)
        for c in configs:
            pw, ph = c["preview_wh"]
            r = run_bench(args.bin, W, H, scen, c["preview_wh"], c["hz"],
                          c["fanout"], pace, frames, args.wasm_dir, args.port)
            cpu_pct = r.cpu_s / window_s * 100
            dcpu_pct = max(0.0, r.cpu_s - base_cpu) / window_s * 100
            cpu_ms_per = (r.cpu_s * 1000 / r.nbpv) if r.nbpv else float("nan")
            prev_fps = r.nbpv / window_s
            mbps = r.nbpv_bytes / window_s / 1e6
            label = f"{pw}x{ph} hz{c['hz']} f{c['fanout']}"
            print(f"{label:<20} {cpu_pct:>6.0f} {dcpu_pct:>7.0f} {cpu_ms_per:>8.1f} "
                  f"{prev_fps:>8.1f} {mbps:>8.1f} {r.p95_ms:>7.2f} {r.rss_mb:>6.0f}",
                  flush=True)
        print()

    print("# cpu%   = total user+sys CPU / wall (includes the render floor)")
    print(f"# Δcpu%  = preview-attributable CPU (minus the {base_cpu:.2f} CPU-s render floor)")
    print("# cpu-ms/prevfrm = CPU spent per delivered preview frame, all threads")
    print("# MB/s   = measured preview wire bytes across all fan-out lanes")

    if args.sample:
        print("\n# --sample: profiling worst case (full-res preview) with `sample`…")
        out = os.path.join(REPO, "native", "build",
                           f"preview_sweep_sample_{W}x{H}.txt")
        env = dict(os.environ)
        env["NANO_BARREL_PREVIEW_HZ"] = "30"; env["NANO_PREVIEW_FANOUT"] = "8"
        env["NANO_BARREL_WASM_DIR"] = args.wasm_dir
        long_frames = int(pace * max(args.secs, 20))
        p = subprocess.Popen([args.bin, "--pace", str(pace), "--frames", str(long_frames),
                              "--w", str(W), "--h", str(H), "--only", scen,
                              "--preview-w", str(W), "--preview-h", str(H),
                              "--port", str(args.port)],
                             cwd=REPO, env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(3.0)  # let it get past init/warmup into steady state
        subprocess.run(["sample", str(p.pid), "10", "-file", out], cwd=REPO)
        p.terminate()
        print(f"#   hotspot profile → {out}")
        print("#   open it and look under BarrelRuntime::render / readback / lane send")


if __name__ == "__main__":
    main()
