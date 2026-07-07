#!/usr/bin/env python3
"""soak_test.py — long-running stability / memory soak for the native barrel executor.

Uses `ffgl_runner` (build/ffgl_runner) as the host: it dlopens the NanoBarrel FFGL
bundle, loads a multi-effect sketch (--config) and paces ProcessOpenGL on the wall
clock (--serve), exactly like Resolume would. Meanwhile this script:

  * drives PARAMETER CHANGES over the barrel's WS bridge (port 8081) the way the
    web editor does — random field nudges, looper trigger pulses, strict-mode /
    loop-mode churn — so the dirty/patch/re-apply path is exercised continuously;
  * samples CPU + GPU MEMORY of the runner process via `footprint` (phys_footprint
    and the IOAccelerator/"(graphics)" regions — GPU lives in unified memory on
    Apple Silicon) plus RSS via `ps`;
  * parses the runner's own fps / ProcessOpenGL timing lines;
  * detects CRASHES (early exit, signal, assert/abort in the log).

At the end it writes a CSV timeline and prints a summary with a least-squares
memory-growth slope (MB/min) so a slow leak — the class of bug this is meant to
catch, e.g. the val-handle leak that froze the executor — is obvious.

Pure stdlib; no pip deps. macOS only (footprint/ps/vmmap).

Example:
  python3 native/tools/soak_test.py --duration 600 --hz 60 \
      --bundle build/NanoBarrel.bundle --sketch native/tools/soak_sketch.json

Interpreting results:
  * phys_footprint is the authoritative total (unified memory → includes GPU on
    Apple Silicon); GPU is broken out from the IOAccelerator/"(graphics)" regions.
  * A real LEAK trends phys upward without bound → a large positive MB/min slope.
  * A bounded cache SAWTOOTHS (grows, then releases tens of MB at once). Prefer
    longer runs (many minutes): the slope then averages over several sawtooth
    periods. On a short run a single cache flush can dominate the linear fit, so
    also read the start/end/peak/delta line and the CSV.
"""

import argparse
import base64
import json
import os
import re
import signal
import socket
import statistics
import struct
import subprocess
import sys
import threading
import time
from collections import deque


# --------------------------------------------------------------------------
# Minimal RFC6455 WebSocket client (send text + drain), no external deps.
# --------------------------------------------------------------------------
class WS:
    def __init__(self, port, timeout=3.0):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("ws handshake closed")
            buf += chunk
        self._rx = buf.split(b"\r\n\r\n", 1)[1]  # any framed bytes after headers

    def send_text(self, payload: str):
        data = payload.encode()
        header = bytearray([0x81])  # FIN + text
        mask = os.urandom(4)
        n = len(data)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(bytes(header) + masked)

    def _recv_more(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise ConnectionError("ws closed")
        self._rx += chunk

    def recv_text(self, deadline):
        """Read one server text frame (server frames are unmasked). Best-effort."""
        while True:
            while len(self._rx) < 2:
                if time.time() > deadline:
                    return None
                try:
                    self._recv_more()
                except socket.timeout:
                    return None
            b0, b1 = self._rx[0], self._rx[1]
            opcode = b0 & 0x0F
            ln = b1 & 0x7F
            pos = 2
            if ln == 126:
                while len(self._rx) < 4:
                    self._recv_more()
                ln = struct.unpack(">H", self._rx[2:4])[0]
                pos = 4
            elif ln == 127:
                while len(self._rx) < 10:
                    self._recv_more()
                ln = struct.unpack(">Q", self._rx[2:10])[0]
                pos = 10
            while len(self._rx) < pos + ln:
                if time.time() > deadline:
                    return None
                try:
                    self._recv_more()
                except socket.timeout:
                    return None
            frame = self._rx[pos:pos + ln]
            self._rx = self._rx[pos + ln:]
            if opcode == 0x1:  # text
                return frame.decode(errors="replace")
            if opcode == 0x8:  # close
                return None
            # ignore ping/pong/binary; keep reading

    def close(self):
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


def discover_barrel_key(port, plugin_id="com.nano.nanobarrel", tries=60):
    """Ask /global/plugins for the runtime-assigned barrel instance key."""
    for _ in range(tries):
        try:
            ws = WS(port)
            ws.send_text(json.dumps({"action": "get", "path": "/global/plugins"}))
            resp = ws.recv_text(time.time() + 2.0)
            ws.close()
            if resp:
                j = json.loads(resp)
                for p in j.get("data", []):
                    if not p.get("key"):
                        continue
                    if p.get("metadata", {}).get("id") == plugin_id:
                        return p["key"]
        except (OSError, ValueError):
            pass
        time.sleep(0.25)
    return None


# --------------------------------------------------------------------------
# Memory sampling (macOS): footprint (phys + GPU) + ps (RSS).
# --------------------------------------------------------------------------
_UNIT = {"B": 1, "KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3}
_FOOT_LINE = re.compile(r"^\s*([\d.]+)\s+(B|KB|MB|GB)\b", re.M)
_PHYS = re.compile(r"phys_footprint:\s*([\d.]+)\s*(B|KB|MB|GB)")


def sample_rss_kb(pid):
    try:
        out = subprocess.check_output(["ps", "-o", "rss=", "-p", str(pid)],
                                      text=True, stderr=subprocess.DEVNULL)
        return int(out.strip()) if out.strip() else None
    except (subprocess.CalledProcessError, ValueError):
        return None


def sample_footprint(pid):
    """Return (phys_bytes, gpu_bytes) via `footprint -p`, or (None, None)."""
    try:
        out = subprocess.check_output(["footprint", "-p", str(pid)],
                                      text=True, stderr=subprocess.DEVNULL,
                                      timeout=10)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return None, None
    phys = None
    m = _PHYS.search(out)
    if m:
        phys = float(m.group(1)) * _UNIT[m.group(2)]
    gpu = 0.0
    for line in out.splitlines():
        low = line.lower()
        if "graphic" in low or "ioaccel" in low:
            m = _FOOT_LINE.match(line)
            if m:
                gpu += float(m.group(1)) * _UNIT[m.group(2)]
    return phys, gpu


# --------------------------------------------------------------------------
# Parameter driver — random churn over the WS bridge.
# --------------------------------------------------------------------------
class Driver:
    # numeric fields worth nudging per instance (skip arrays like grid).
    def __init__(self, port, key, sketch, rng, mode="full"):
        self.port = port
        self.key = key
        self.rng = rng
        self.mode = mode  # full | fields (only param nudges) | triggers (only looper)
        self.ws = None
        self._drain_stop = threading.Event()
        self._drain = None
        # Build (inst, field, lo, hi) targets from the sketch's initial state.
        self.targets = []
        for inst, spec in sketch.get("instances", {}).items():
            for field, val in spec.get("state", {}).items():
                if isinstance(val, bool):
                    self.targets.append((inst, field, 0.0, 1.0))
                elif isinstance(val, (int, float)):
                    hi = 1.0 if abs(val) <= 1.0 else 2.0 * abs(val)
                    self.targets.append((inst, field, 0.0, hi))
        self.looper = next((i for i, s in sketch.get("instances", {}).items()
                            if s.get("module_type") == "control.nanolooper"), None)
        self.stats = {"patches": 0, "trigger_pulses": 0, "errors": 0, "reconnects": 0}

    def connect(self):
        try:
            self.ws = WS(self.port)
            # Observe the state so the instance counts as "watched" (drives the
            # telemetry/preview path), and drain server pushes so they never
            # backpressure and skew timing.
            self.ws.send_text(json.dumps(
                {"action": "observe", "path": f"/plugins/{self.key}/state"}))
            self._drain_stop.clear()
            self._drain = threading.Thread(target=self._drain_loop, daemon=True)
            self._drain.start()
            return True
        except OSError:
            self.ws = None
            return False

    def _drain_loop(self):
        while not self._drain_stop.is_set():
            try:
                self.ws.recv_text(time.time() + 0.5)
            except (OSError, ValueError):
                return

    def _patch(self, field_path, value):
        msg = json.dumps({
            "action": "patch",
            "target": f"/plugins/{self.key}/state",
            "ops": [{"op": "replace",
                     "path": f"/sketch/instances/{field_path}", "value": value}],
        })
        try:
            if self.ws is None and not self.connect():
                self.stats["errors"] += 1
                return
            self.ws.send_text(msg)
            self.stats["patches"] += 1
        except OSError:
            self.stats["errors"] += 1
            self.stats["reconnects"] += 1
            try:
                self.ws.close()
            except Exception:
                pass
            self.ws = None

    def tick(self):
        """One churn step: nudge a few fields; sometimes stress the looper."""
        if self.mode in ("full", "fields") and self.targets:
            for _ in range(self.rng.randint(1, 3)):
                inst, field, lo, hi = self.rng.choice(self.targets)
                v = round(self.rng.uniform(lo, hi), 4)
                self._patch(f"{inst}/state/{field}", v)
        if self.mode == "fields":
            return
        r = self.rng.random()
        if self.looper and r < 0.25:
            # Pulse a trigger (records a note → fat publish tree next frames).
            ch = self.rng.randint(1, 4)
            self._patch(f"{self.looper}/state/trigger_{ch}", 1.0)
            self._patch(f"{self.looper}/state/trigger_{ch}", 0.0)
            self.stats["trigger_pulses"] += 1
        elif self.looper and r < 0.35:
            # Toggle strict mode (queue + deadline-flush churn) / loop mode.
            self._patch(f"{self.looper}/state/strict_deadline",
                        self.rng.choice([0.0, 60.0, 120.0, 250.0]))
            self._patch(f"{self.looper}/state/loop_mode",
                        float(self.rng.randint(0, 2)))

    def close(self):
        self._drain_stop.set()
        if self._drain:
            self._drain.join(timeout=1.0)
        if self.ws:
            self.ws.close()


# --------------------------------------------------------------------------
# Runner process management + stderr scraping.
# --------------------------------------------------------------------------
_FPS = re.compile(r"serve:\s*([\d.]+)\s*fps,\s*ProcessOpenGL avg\s*([\d.]+)\s*ms")
_BAD = re.compile(r"assert|abort|segmentation|fatal|terminating|trap|panic|"
                  r"bad_alloc|out of memory|std::__1", re.I)


class Runner:
    def __init__(self, args):
        self.args = args
        self.proc = None
        self.fps = []          # (t, fps, procMs)
        self.log_tail = deque(maxlen=200)
        self.bad_lines = []
        self._t0 = None
        self._reader = None

    def start(self):
        env = dict(os.environ)
        env["NANO_BRIDGE_PORT"] = str(self.args.port)
        # The HARNESS owns the lifetime: it stops the runner (SIGINT) at
        # --duration. Give the runner a longer serve cap purely as a safety net
        # so an orphaned runner (if the harness dies) still self-terminates.
        cmd = [
            self.args.runner, self.args.bundle,
            str(self.args.width), str(self.args.height),
            "--config", self.args.sketch,
            "--bpm", str(self.args.bpm),
            "--serve", str(self.args.hz), str(self.args.duration + 30.0),
        ]
        print("[soak] launching:", " ".join(cmd), flush=True)
        self.proc = subprocess.Popen(
            cmd, cwd=self.args.cwd, env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            text=True, bufsize=1)
        self._t0 = time.time()
        self._reader = threading.Thread(target=self._read_stderr, daemon=True)
        self._reader.start()

    def _read_stderr(self):
        for line in self.proc.stderr:
            line = line.rstrip("\n")
            self.log_tail.append(line)
            m = _FPS.search(line)
            if m:
                self.fps.append((time.time() - self._t0,
                                 float(m.group(1)), float(m.group(2))))
            elif _BAD.search(line):
                self.bad_lines.append(line)

    def poll(self):
        return self.proc.poll()

    def stop(self):
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGINT)
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self._reader:
            self._reader.join(timeout=2)


# --------------------------------------------------------------------------
# Least-squares slope of y over t (returns units of y per second).
# --------------------------------------------------------------------------
def slope_per_sec(ts, ys, warmup=0.0):
    # Exclude the warmup window (startup page-in, text-atlas fill, PSO compile)
    # so the regression measures steady-state growth, not one-time settling.
    pts = [(t, y) for t, y in zip(ts, ys) if y is not None and t >= warmup]
    if len(pts) < 3:
        pts = [(t, y) for t, y in zip(ts, ys) if y is not None]
    if len(pts) < 3:
        return 0.0
    n = len(pts)
    st = sum(t for t, _ in pts)
    sy = sum(y for _, y in pts)
    stt = sum(t * t for t, _ in pts)
    sty = sum(t * y for t, y in pts)
    denom = n * stt - st * st
    return (n * sty - st * sy) / denom if denom else 0.0


def mb(x):
    return "n/a" if x is None else f"{x / 1024 / 1024:8.1f} MB"


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(os.path.dirname(here))  # repo root (…/text)
    ap.add_argument("--runner", default=os.path.join(root, "native/build/ffgl_runner"))
    ap.add_argument("--bundle", default=os.path.join(root, "native/build/NanoBarrel.bundle"))
    ap.add_argument("--sketch", default=os.path.join(here, "soak_sketch.json"))
    ap.add_argument("--cwd", default=os.path.join(root, "native"),
                    help="runner working dir (so libbridge_server.dylib resolves)")
    ap.add_argument("--duration", type=float, default=300.0, help="seconds")
    ap.add_argument("--hz", type=float, default=60.0, help="render pacing")
    ap.add_argument("--bpm", type=float, default=120.0, help="fake transport bpm")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--port", type=int, default=8081)
    ap.add_argument("--sample-interval", type=float, default=5.0)
    ap.add_argument("--param-interval", type=float, default=1.5)
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--warmup-sec", type=float, default=30.0,
                    help="exclude this leading window from the leak-slope fit")
    ap.add_argument("--csv", default="/tmp/soak_timeline.csv")
    ap.add_argument("--no-drive", action="store_true", help="don't change params")
    ap.add_argument("--drive-mode", choices=["full", "fields", "triggers"],
                    default="full", help="what the driver churns (bisect leaks)")
    ap.add_argument("--leak-threshold-mb-min", type=float, default=2.0,
                    help="flag a leak if phys grows faster than this")
    args = ap.parse_args()

    import random
    rng = random.Random(args.seed)

    with open(args.sketch) as f:
        sketch = json.load(f)

    if not os.path.exists(args.runner):
        print(f"[soak] runner not found: {args.runner}\n"
              f"       build it: cmake --build native/build --target ffgl_runner", file=sys.stderr)
        return 2

    runner = Runner(args)
    runner.start()
    pid = runner.proc.pid
    print(f"[soak] runner pid={pid}  duration={args.duration}s  "
          f"{args.width}x{args.height}@{args.hz}Hz  bpm={args.bpm}", flush=True)

    # Wait for the WS bridge + discover the barrel key.
    driver = None
    if not args.no_drive:
        key = discover_barrel_key(args.port)
        if key:
            print(f"[soak] barrel key={key}", flush=True)
            driver = Driver(args.port, key, sketch, rng, mode=args.drive_mode)
            driver.connect()
        else:
            print("[soak] WARNING: could not find barrel key — running WITHOUT param drive",
                  flush=True)

    # Timelines.
    T, RSS, PHYS, GPU = [], [], [], []
    csv = open(args.csv, "w")
    csv.write("t_sec,rss_mb,phys_mb,gpu_mb,fps,proc_ms\n")

    start = time.time()
    next_sample = start
    next_param = start + 1.0
    crashed = False
    try:
        while True:
            now = time.time()
            elapsed = now - start
            rc = runner.poll()
            if rc is not None:
                # The runner exited on its OWN before we asked it to → crash /
                # unexpected early exit (its serve cap is duration+30).
                crashed = True
                break
            if elapsed >= args.duration:
                break

            if driver and now >= next_param:
                driver.tick()
                next_param = now + args.param_interval

            if now >= next_sample:
                rss = sample_rss_kb(pid)
                phys, gpu = sample_footprint(pid)
                recent = [f for t, f, _ in runner.fps if t >= elapsed - args.sample_interval]
                recent_ms = [m for t, _, m in runner.fps if t >= elapsed - args.sample_interval]
                fps = statistics.mean(recent) if recent else None
                pms = statistics.mean(recent_ms) if recent_ms else None
                T.append(elapsed)
                RSS.append(rss * 1024 if rss else None)
                PHYS.append(phys)
                GPU.append(gpu)
                cell = lambda v, s=1.0, p=1: "" if v is None else f"{v * s:.{p}f}"
                csv.write(",".join([
                    f"{elapsed:.1f}",
                    cell(rss, 1 / 1024),
                    cell(phys, 1 / 1024 / 1024),
                    cell(gpu, 1 / 1024 / 1024),
                    cell(fps),
                    cell(pms, 1.0, 2),
                ]) + "\n")
                csv.flush()
                print(f"[soak] t={elapsed:6.0f}s  rss={mb(RSS[-1])}  "
                      f"phys={mb(phys)}  gpu={mb(gpu)}  "
                      f"fps={'n/a' if fps is None else f'{fps:5.1f}'}  "
                      f"proc={'n/a' if pms is None else f'{pms:4.2f}ms'}  "
                      f"patches={driver.stats['patches'] if driver else 0}",
                      flush=True)
                next_sample = now + args.sample_interval

            time.sleep(0.1)
    except KeyboardInterrupt:
        print("\n[soak] interrupted — stopping", flush=True)
    finally:
        if driver:
            driver.close()
        runner.stop()
        csv.close()

    # ---- Summary ----
    rc = runner.proc.returncode
    # The harness stops the runner with SIGINT at --duration, so those are CLEAN
    # shutdowns; a real crash is an unexpected early exit (`crashed`) or any other
    # signal (SIGSEGV -11, SIGABRT -6, SIGBUS -10, ...).
    CLEAN_STOP = {0, -signal.SIGINT, -signal.SIGTERM}
    is_crash = crashed or (rc is not None and rc not in CLEAN_STOP)
    dur = (T[-1] if T else 0.0)
    phys_slope = slope_per_sec(T, PHYS, args.warmup_sec) * 60.0      # bytes/min
    gpu_slope = slope_per_sec(T, GPU, args.warmup_sec) * 60.0
    rss_slope = slope_per_sec(T, RSS, args.warmup_sec) * 60.0
    fps_vals = [f for _, f, _ in runner.fps]
    ms_vals = [m for _, _, m in runner.fps]

    print("\n" + "=" * 68)
    print("SOAK SUMMARY")
    print("=" * 68)
    print(f"  duration sampled : {dur:.0f}s over {len(T)} samples")
    exit_note = ""
    if crashed:
        exit_note = "  <-- UNEXPECTED EARLY EXIT"
    elif rc is not None and rc < 0 and rc not in CLEAN_STOP:
        exit_note = f"  <-- CRASH (signal {-rc})"
    elif rc in CLEAN_STOP:
        exit_note = "  (clean shutdown)"
    print(f"  runner exit code : {rc}{exit_note}")
    if driver:
        print(f"  param churn      : {driver.stats}")
    if PHYS and any(p is not None for p in PHYS):
        p0 = next(p for p in PHYS if p is not None)
        p1 = next(p for p in reversed(PHYS) if p is not None)
        peak = max(p for p in PHYS if p is not None)
        print(f"  phys_footprint   : start {mb(p0)}  end {mb(p1)}  peak {mb(peak)}"
              f"  delta {mb(p1 - p0)}")
    print(f"  (slopes exclude first {args.warmup_sec:.0f}s warmup)")
    print(f"  RSS  slope       : {rss_slope/1024/1024:+.3f} MB/min")
    print(f"  phys slope       : {phys_slope/1024/1024:+.3f} MB/min")
    print(f"  GPU  slope       : {gpu_slope/1024/1024:+.3f} MB/min")
    if fps_vals:
        print(f"  fps  min/avg     : {min(fps_vals):.1f} / {statistics.mean(fps_vals):.1f}")
        print(f"  ProcessOpenGL ms : avg {statistics.mean(ms_vals):.2f}  max {max(ms_vals):.2f}")
    if runner.bad_lines:
        print(f"  suspicious log   : {len(runner.bad_lines)} line(s):")
        for l in runner.bad_lines[:6]:
            print("      " + l)
    print(f"  csv timeline     : {args.csv}")

    leak = phys_slope / 1024 / 1024 > args.leak_threshold_mb_min
    verdict_bad = is_crash or leak or runner.bad_lines
    if is_crash:
        print("\n  VERDICT: FAIL — the runner crashed / exited early.")
        print("  --- log tail ---")
        for l in list(runner.log_tail)[-25:]:
            print("    " + l)
    elif leak:
        print(f"\n  VERDICT: FAIL — phys_footprint grew {phys_slope/1024/1024:.2f} MB/min "
              f"(> {args.leak_threshold_mb_min} threshold). Likely a leak.")
    elif runner.bad_lines:
        print("\n  VERDICT: WARN — suspicious log lines (see above).")
    else:
        print("\n  VERDICT: PASS — stable, no crash, no significant growth.")
    print("=" * 68)
    return 1 if verdict_bad else 0


if __name__ == "__main__":
    sys.exit(main())
