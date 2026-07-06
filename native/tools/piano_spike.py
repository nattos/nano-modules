#!/usr/bin/env python3
"""
piano_spike.py — latency spike for Resolume's "sticky piano trigger" bug.

Resolume "piano" clips are momentary: connected while a note is held, disconnect
on release. A Resolume bug leaves them STUCK-ON when the on/off edges come fast,
so short staccato triggers don't reliably release. The shared bridge server works
around it today with a reconcile loop (clip_launcher.cpp) whose feedback is the
FULL-composition rebroadcast (~1 s lag) gated by a 250 ms debounce — reliable but
high-latency, so we can't do crisp staccato. This harness is the spike bench to
find a lower-latency release algorithm.

It connects to BOTH ends and timestamps everything off one monotonic clock:

  * Resolume WS  (ws://127.0.0.1:8080/api/v1, env NANO_RESOLUME_URL)
      - reads the composition, finds clips by name (default "Red"/"Blue"),
      - connects/disconnects them via the `trigger` action, and
      - SUBSCRIBES to each clip's `connected` param so state changes arrive as
        push `parameter_update`s in ~ms instead of the ~1 s rebroadcast.
        This is the CONTROL-signal ground truth.

  * bridge server WS (ws://localhost:8081, env NANO_BRIDGE_PORT)
      - observes the empty NanoBarrel instance on the layer, requests its
        `sketch_output` thumbnail, reassembles NBPC->NBPV, and classifies the
        average colour (red / blue / black). This is the VISUAL ground truth of
        what is actually on screen — what the user ultimately cares about.

Modes:
  monitor  — stream both channels live; tap in Resolume and watch the latency.
  pulse    — fire one connect + timed release with a chosen strategy; report the
             state + visual release latency and whether it stuck.
  sweep    — sweep pulse durations x release strategies; report the minimum
             reliable staccato duration and stuck-rate per strategy. The bench.
  selftest — decode a synthetic NBPV frame; no network. Sanity-checks the codec.

Setup (websockets isn't in the system python; use an isolated venv):
    python3 -m venv /tmp/piano-spike-venv
    /tmp/piano-spike-venv/bin/pip install websockets
    /tmp/piano-spike-venv/bin/python native/tools/piano_spike.py monitor

Everything is tweakable — strategies are just async functions in STRATEGIES; add
a hypothesis, point it at live Resolume, and sweep.
"""

import argparse
import asyncio
import json
import os
import struct
import sys
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

try:
    import websockets
except ImportError:
    sys.stderr.write(
        "\n[piano_spike] the 'websockets' package is required and is not in this "
        "python.\nCreate an isolated venv (system python blocks pip via PEP 668):\n"
        "    python3 -m venv /tmp/piano-spike-venv\n"
        "    /tmp/piano-spike-venv/bin/pip install websockets\n"
        "    /tmp/piano-spike-venv/bin/python native/tools/piano_spike.py ...\n\n")
    sys.exit(1)


# --------------------------------------------------------------------------- #
# Clock + logging — one monotonic origin so both channels share a timeline.
# --------------------------------------------------------------------------- #

_T0 = time.perf_counter()


def now_ms() -> float:
    return (time.perf_counter() - _T0) * 1000.0


def log(tag: str, msg: str = "") -> None:
    print(f"[{now_ms():9.1f}ms] {tag:<10} {msg}", flush=True)


def _resolve(waiters: List[asyncio.Future]) -> None:
    """Resolve and drop every pending waiter future. Called from the recv loop
    on a state/colour change. Edge-safe: waiters register their future before
    awaiting (no await between the state check and the append), so a change can
    never be signalled into the gap and lost — unlike Event.set()+clear()."""
    if not waiters:
        return
    pending = waiters[:]
    waiters.clear()
    for f in pending:
        if not f.done():
            f.set_result(None)


# --------------------------------------------------------------------------- #
# Resolume side
# --------------------------------------------------------------------------- #

def _is_connected(value: str) -> bool:
    # connected.options == ["Empty","Disconnected","Previewing","Connected",
    #                       "Connected & previewing"]. "Connected" substring
    # covers both live states; everything else is off-screen.
    return "Connected" in (value or "")


@dataclass
class ClipRef:
    name: str
    layer_idx: int          # 0-based
    clip_idx: int           # 0-based
    connect_path: str       # /composition/layers/L/clips/C/connect (1-based)
    connected_id: int       # param id of the `connected` ParamState (subscribe)
    trigger_style: str      # "Normal" | "Piano" | "Toggle" | "Composition Determined"
    connected_value: str = "Empty"
    connected_ms: float = 0.0   # when connected_value last changed


class ResolumeClient:
    """Talks the Resolume WS API: read composition, trigger clips, subscribe to
    each clip's connected-state param for push updates."""

    def __init__(self, url: str):
        self.url = url
        self.ws = None
        self.clips: Dict[str, ClipRef] = {}     # name(lower) -> ClipRef
        self.by_id: Dict[int, ClipRef] = {}     # connected_id -> ClipRef
        self._subscribed: set = set()
        self._waiters: List[asyncio.Future] = []  # resolved on any connected change
        self.ready = asyncio.Event()            # set once composition parsed
        self.verbose = True

    async def connect(self):
        self.ws = await websockets.connect(self.url, max_size=None, ping_interval=None)
        log("RESOLUME", f"connected {self.url}")
        asyncio.create_task(self._recv_loop())

    async def _recv_loop(self):
        async for raw in self.ws:
            t = now_ms()
            if isinstance(raw, bytes):
                continue
            try:
                j = json.loads(raw)
            except Exception:
                continue
            typ = j.get("type")
            if typ is None and ("layers" in j or "decks" in j):
                self._on_composition(j)
            elif typ in ("parameter_subscribed", "parameter_update"):
                self._on_param(j, t)

    def _on_composition(self, comp: dict):
        clips: Dict[str, ClipRef] = {}
        by_id: Dict[int, ClipRef] = {}
        layers = comp.get("layers", []) or []
        for li, layer in enumerate(layers):
            for ci, clip in enumerate(layer.get("clips", []) or []):
                name = (clip.get("name") or {}).get("value", "") or ""
                conn = clip.get("connected") or {}
                cid = conn.get("id")
                if cid is None:
                    continue
                style = (clip.get("triggerstyle") or {}).get("value", "")
                # Preserve last-known live state across rebroadcasts.
                prev = self.by_id.get(cid)
                ref = ClipRef(
                    name=name, layer_idx=li, clip_idx=ci,
                    connect_path=f"/composition/layers/{li+1}/clips/{ci+1}/connect",
                    connected_id=cid, trigger_style=style,
                    connected_value=conn.get("value", "Empty"),
                    connected_ms=prev.connected_ms if prev else 0.0)
                if name:
                    clips[name.lower()] = ref
                by_id[cid] = ref
        self.clips = clips
        self.by_id = by_id
        first = not self.ready.is_set()
        self.ready.set()
        if first and self.verbose:
            named = [r for r in by_id.values() if r.name]
            log("RESOLUME", f"composition: {len(layers)} layers, "
                            f"{len(by_id)} clips ({len(named)} named)")
            for r in sorted(named, key=lambda r: (r.layer_idx, r.clip_idx)):
                log("  clip", f'"{r.name}"  L{r.layer_idx+1}C{r.clip_idx+1}  '
                              f'style={r.trigger_style or "?"}  '
                              f'state={r.connected_value}  id={r.connected_id}')
        # (Re)subscribe to every named clip's connected param for push updates.
        asyncio.create_task(self._ensure_subscriptions())

    async def _ensure_subscriptions(self):
        for ref in list(self.by_id.values()):
            if ref.connected_id in self._subscribed:
                continue
            self._subscribed.add(ref.connected_id)
            await self._send({"action": "subscribe",
                              "parameter": f"/parameter/by-id/{ref.connected_id}"})

    def _on_param(self, j: dict, t: float):
        cid = j.get("id")
        ref = self.by_id.get(cid)
        if ref is None:
            return
        val = j.get("value")
        if not isinstance(val, str):
            return
        if val != ref.connected_value:
            ref.connected_value = val
            ref.connected_ms = t
            _resolve(self._waiters)
            if self.verbose:
                log("RES-STATE", f'"{ref.name}" -> {val}')

    async def _send(self, obj: dict):
        await self.ws.send(json.dumps(obj))

    def get(self, name: str) -> ClipRef:
        ref = self.clips.get(name.lower())
        if ref is None:
            raise KeyError(f'clip "{name}" not found; known: '
                           f'{[r.name for r in self.by_id.values() if r.name]}')
        return ref

    async def trigger(self, ref: ClipRef, on: bool):
        await self._send({"action": "trigger", "parameter": ref.connect_path,
                          "value": bool(on)})

    async def wait_state(self, ref: ClipRef, want_connected: bool,
                         timeout_ms: float) -> Optional[float]:
        """Wait until ref's connected state matches want_connected. Returns the
        timestamp (ms) of the matching change, or None on timeout. Race-free:
        the check and the waiter-registration run without an await between them
        (single-threaded loop), so no state change can slip through unseen."""
        deadline = now_ms() + timeout_ms
        while True:
            if _is_connected(ref.connected_value) == want_connected:
                return ref.connected_ms
            remain = (deadline - now_ms()) / 1000.0
            if remain <= 0:
                return None
            fut = asyncio.get_event_loop().create_future()
            self._waiters.append(fut)
            try:
                await asyncio.wait_for(fut, remain)
            except asyncio.TimeoutError:
                return None


# --------------------------------------------------------------------------- #
# Bridge side (thumbnails)
# --------------------------------------------------------------------------- #

@dataclass
class Thumb:
    label: str = "none"          # red | blue | black | other | none
    rgb: Tuple[float, float, float] = (0.0, 0.0, 0.0)
    ms: float = 0.0              # when label last changed


class NbpcReassembler:
    """Collect NBPC chunks (12-byte header "NBPC", u32 seq, u16 idx, u16 count,
    LE) striped across lane sockets into whole NBPV frames."""

    def __init__(self):
        self._pending: Dict[int, Dict[int, bytes]] = {}
        self._count: Dict[int, int] = {}

    def feed(self, buf: bytes) -> Optional[bytes]:
        if len(buf) < 4 or buf[:4] != b"NBPC":
            return buf if buf[:4] == b"NBPV" else None  # back-compat whole frame
        seq, idx, count = struct.unpack_from("<IHH", buf, 4)
        payload = buf[12:]
        slot = self._pending.setdefault(seq, {})
        slot[idx] = payload
        self._count[seq] = count
        if len(slot) < count:
            return None
        frame = b"".join(slot[i] for i in range(count))
        del self._pending[seq]
        del self._count[seq]
        return frame


def decode_nbpv(frame: bytes) -> Optional[Tuple[str, int, int, bytes]]:
    """-> (traceId, width, height, rgba). See preview_codec.h (NBPV v2)."""
    if len(frame) < 14 or frame[:4] != b"NBPV":
        return None
    version, fmt = frame[4], frame[5]
    if version != 2 or fmt != 1:
        return None
    key_len, id_len, width, height = struct.unpack_from("<HHHH", frame, 6)
    off = 14
    key = frame[off:off + key_len].decode("utf-8", "replace"); off += key_len
    trace = frame[off:off + id_len].decode("utf-8", "replace"); off += id_len
    px = frame[off:off + width * height * 4]
    return trace, width, height, px


def classify(rgba: bytes, w: int, h: int) -> Tuple[str, Tuple[float, float, float]]:
    n = w * h
    if n == 0 or len(rgba) < n * 4:
        return "none", (0.0, 0.0, 0.0)
    # Mean over a stride sample (full-res thumbs can be large; every 4th px).
    sr = sg = sb = 0
    cnt = 0
    for i in range(0, n * 4, 16):
        sr += rgba[i]; sg += rgba[i + 1]; sb += rgba[i + 2]
        cnt += 1
    r, g, b = sr / cnt, sg / cnt, sb / cnt
    mx = max(r, g, b)
    if mx < 40:
        return "black", (r, g, b)
    if r > g + 40 and r > b + 40:
        return "red", (r, g, b)
    if b > r + 40 and b > g + 40:
        return "blue", (r, g, b)
    return "other", (r, g, b)


class BridgeClient:
    """Observes an instance's thumbnail over the bridge server's preview path."""

    def __init__(self, url: str, thumb_w: int, thumb_h: int):
        self.url = url
        self.thumb_w = thumb_w
        self.thumb_h = thumb_h
        self.main = None
        self.key: Optional[str] = None
        self.lane_ports: List[int] = []
        self.reasm = NbpcReassembler()
        self.thumb = Thumb()
        self._waiters: List[asyncio.Future] = []
        self.ready = asyncio.Event()
        self.verbose = True
        self._snap_futs: Dict[str, asyncio.Future] = {}

    async def connect(self, want_key: Optional[str] = None):
        self.main = await websockets.connect(self.url, max_size=None, ping_interval=None)
        log("BRIDGE", f"connected {self.url}")
        asyncio.create_task(self._recv_main())
        plugins = await self._snapshot("/global/plugins")
        self.key = self._pick_barrel(plugins, want_key)
        if self.key is None:
            log("BRIDGE", "no NanoBarrel instance in /global/plugins — "
                          "thumbnails unavailable (state channel still works)")
            return
        log("BRIDGE", f"barrel instance key={self.key}")
        transport = await self._snapshot("/global/preview_transport")
        self.lane_ports = list((transport or {}).get("ports", []))
        log("BRIDGE", f"preview lanes: {self.lane_ports or '(none; main-socket frames)'}")
        for p in self.lane_ports:
            asyncio.create_task(self._recv_lane(p))
        await self._observe(f"/plugins/{self.key}/state")
        await self._request_preview()
        self.ready.set()

    def _pick_barrel(self, plugins, want_key):
        if not isinstance(plugins, list):
            return None
        entries = []
        for p in plugins:
            key = p.get("key")
            if not key:
                continue
            pid = str((p.get("metadata") or {}).get("id", "")).lower()
            entries.append((key, pid, p))
        if want_key:
            for key, _, _ in entries:
                if key == want_key:
                    return key
            log("BRIDGE", f"requested key {want_key} not present")
        barrels = [e for e in entries if "barrel" in e[1] or "barrel" in e[0].lower()]
        if len(barrels) == 1:
            return barrels[0][0]
        if len(barrels) > 1:
            log("BRIDGE", f"multiple barrels {[b[0] for b in barrels]}; "
                          f"pass --barrel-key. Using first.")
            return barrels[0][0]
        if len(entries) == 1:
            return entries[0][0]
        if entries:
            log("BRIDGE", f"instances present but none look like a barrel: "
                          f"{[(e[0], e[1]) for e in entries]}; pass --barrel-key.")
        return None

    async def _request_preview(self):
        reqs = {f"inst_thumb:{self.key}": {
            "target": {"type": "sketch_output"},
            "width": self.thumb_w, "height": self.thumb_h}}
        await self._patch(f"/plugins/{self.key}/state",
                          [{"op": "add", "path": "/preview_requests", "value": reqs}])
        log("BRIDGE", f"requested sketch_output thumbnail "
                      f"{self.thumb_w}x{self.thumb_h} (0=full)")

    async def stop_preview(self):
        if self.key:
            await self._patch(f"/plugins/{self.key}/state",
                              [{"op": "add", "path": "/preview_requests", "value": {}}])

    # -- WS plumbing --------------------------------------------------------- #

    async def _send(self, obj):
        await self.main.send(json.dumps(obj))

    async def _observe(self, path):
        await self._send({"action": "observe", "path": path})

    async def _patch(self, target, ops):
        await self._send({"action": "patch", "target": target, "ops": ops})

    async def _snapshot(self, path):
        fut = asyncio.get_event_loop().create_future()
        self._snap_futs[path] = fut
        await self._send({"action": "get", "path": path})
        try:
            return await asyncio.wait_for(fut, 5.0)
        except asyncio.TimeoutError:
            log("BRIDGE", f"snapshot {path} timed out")
            return None

    async def _recv_main(self):
        async for raw in self.main:
            if isinstance(raw, bytes):
                self._on_frame(raw)
                continue
            try:
                j = json.loads(raw)
            except Exception:
                continue
            if j.get("type") == "snapshot":
                fut = self._snap_futs.pop(j.get("path"), None)
                if fut and not fut.done():
                    fut.set_result(j.get("data"))

    async def _recv_lane(self, port):
        # lane host = main host, different port
        host = self.url.split("://", 1)[-1].split("/", 1)[0].rsplit(":", 1)[0]
        lane_url = f"ws://{host}:{port}/"
        try:
            async with websockets.connect(lane_url, max_size=None, ping_interval=None) as ws:
                async for raw in ws:
                    if isinstance(raw, bytes):
                        self._on_frame(raw)
        except Exception as e:
            log("BRIDGE", f"lane {port} error: {e}")

    def _on_frame(self, buf: bytes):
        frame = self.reasm.feed(buf)
        if frame is None:
            return
        dec = decode_nbpv(frame)
        if dec is None:
            return
        trace, w, h, px = dec
        label, rgb = classify(px, w, h)
        if label != self.thumb.label:
            self.thumb.label = label
            self.thumb.rgb = rgb
            self.thumb.ms = now_ms()
            _resolve(self._waiters)
            if self.verbose:
                log("THUMB", f"{label:<6} rgb=({rgb[0]:.0f},{rgb[1]:.0f},{rgb[2]:.0f})")

    async def wait_color(self, pred: Callable[[str], bool],
                         timeout_ms: float) -> Optional[float]:
        deadline = now_ms() + timeout_ms
        while True:
            if pred(self.thumb.label):
                return self.thumb.ms
            remain = (deadline - now_ms()) / 1000.0
            if remain <= 0:
                return None
            fut = asyncio.get_event_loop().create_future()
            self._waiters.append(fut)
            try:
                await asyncio.wait_for(fut, remain)
            except asyncio.TimeoutError:
                return None


# --------------------------------------------------------------------------- #
# Release strategies — the hypotheses. Each assumes CONNECT was already sent and
# performs the RELEASE. Return when it believes the clip is released (or gives
# up). `res` is the ResolumeClient, `clip` the target ClipRef.
# --------------------------------------------------------------------------- #

async def strat_single(res: ResolumeClient, clip: ClipRef, timeout_ms: float):
    await res.trigger(clip, False)


async def strat_double(res: ResolumeClient, clip: ClipRef, timeout_ms: float):
    await res.trigger(clip, False)
    await res.trigger(clip, False)


async def strat_burst5(res: ResolumeClient, clip: ClipRef, timeout_ms: float):
    for _ in range(5):
        await res.trigger(clip, False)
        await asyncio.sleep(0.010)


async def strat_reconcile_sub(res: ResolumeClient, clip: ClipRef, timeout_ms: float,
                              debounce_ms: float = 30.0):
    """Reconcile toward disconnected using the SUBSCRIBED connected param as
    push feedback + a tight debounce. The hypothesis: this beats the production
    ~1 s rebroadcast + 250 ms debounce by ~an order of magnitude."""
    deadline = now_ms() + timeout_ms
    while now_ms() < deadline:
        await res.trigger(clip, False)
        got = await res.wait_state(clip, want_connected=False, timeout_ms=debounce_ms)
        if got is not None:
            return


async def strat_reconcile_poll(res: ResolumeClient, clip: ClipRef, timeout_ms: float,
                               debounce_ms: float = 250.0):
    """Baseline mimicking today's launcher: resend on a 250 ms debounce. (Here
    it still reads the subscribed state, so it models the debounce cost alone,
    not the extra rebroadcast lag — a conservative baseline.)"""
    deadline = now_ms() + timeout_ms
    while now_ms() < deadline:
        await res.trigger(clip, False)
        got = await res.wait_state(clip, want_connected=False, timeout_ms=debounce_ms)
        if got is not None:
            return


STRATEGIES: Dict[str, Callable] = {
    "single": strat_single,
    "double": strat_double,
    "burst5": strat_burst5,
    "reconcile_sub": strat_reconcile_sub,
    "reconcile_poll": strat_reconcile_poll,
}


# --------------------------------------------------------------------------- #
# Experiments
# --------------------------------------------------------------------------- #

@dataclass
class PulseResult:
    duration_ms: float
    strategy: str
    state_connect_ms: Optional[float] = None   # connect latency (state)
    state_release_ms: Optional[float] = None   # release latency (state)
    visual_connect_ms: Optional[float] = None
    visual_release_ms: Optional[float] = None
    stuck: bool = False


async def run_pulse(res: ResolumeClient, bridge: Optional[BridgeClient],
                    clip: ClipRef, duration_ms: float, strategy: str,
                    timeout_ms: float = 3000.0,
                    settle_ms: float = 400.0) -> PulseResult:
    """Ensure disconnected -> connect -> hold duration_ms -> release via strategy
    -> measure. Latencies are relative to the intent edge (t_on / t_off)."""
    r = PulseResult(duration_ms=duration_ms, strategy=strategy)

    # Baseline: make sure it's off and settled before we start.
    if _is_connected(clip.connected_value):
        await res.trigger(clip, False)
        await res.wait_state(clip, False, 1000.0)
    await asyncio.sleep(settle_ms / 1000.0)
    watch_visual = bridge is not None and bridge.ready.is_set()

    # --- ON edge ---
    t_on = now_ms()
    await res.trigger(clip, True)
    st = await res.wait_state(clip, True, timeout_ms)
    r.state_connect_ms = None if st is None else st - t_on
    if watch_visual:
        vt = await bridge.wait_color(lambda l: l == "blue", 500.0)
        r.visual_connect_ms = None if vt is None else vt - t_on

    # --- hold for the intended gate length (from the ON intent edge) ---
    remain = duration_ms - (now_ms() - t_on)
    if remain > 0:
        await asyncio.sleep(remain / 1000.0)

    # --- OFF edge via the strategy ---
    t_off = now_ms()
    fn = STRATEGIES[strategy]
    await fn(res, clip, timeout_ms)
    st = await res.wait_state(clip, False, timeout_ms)
    if st is None:
        r.stuck = True
    else:
        r.state_release_ms = st - t_off
    if watch_visual:
        vt = await bridge.wait_color(lambda l: l != "blue", timeout_ms)
        r.visual_release_ms = None if vt is None else vt - t_off

    # Safety: if still connected, force it off so the next trial starts clean.
    if _is_connected(clip.connected_value):
        for _ in range(10):
            await res.trigger(clip, False)
            if await res.wait_state(clip, False, 300.0) is not None:
                break
    return r


async def mode_monitor(res, bridge, args):
    log("MODE", "monitor — tap clips in Resolume; state + visual latency stream "
                "below. Ctrl-C to stop.")
    # Everything is already streaming via the recv loops + verbose logs.
    while True:
        await asyncio.sleep(3600)


async def mode_pulse(res, bridge, args):
    clip = res.get(args.clip_blue)
    if clip.trigger_style not in ("Piano", "Composition Determined"):
        log("WARN", f'"{clip.name}" triggerstyle={clip.trigger_style} '
                    f'(expected Piano). Continuing.')
    log("MODE", f'pulse strategy={args.strategy} dur={args.dur}ms '
                f'trials={args.trials} clip="{clip.name}"')
    rows = []
    for i in range(args.trials):
        r = await run_pulse(res, bridge, clip, args.dur, args.strategy)
        rows.append(r)
        _print_pulse(i, r)
        await asyncio.sleep(0.3)
    _summarize([("", args.strategy, args.dur, rows)])


async def mode_sweep(res, bridge, args):
    clip = res.get(args.clip_blue)
    strategies = args.strategies.split(",")
    durs = [float(x) for x in args.durs.split(",")]
    log("MODE", f'sweep clip="{clip.name}" strategies={strategies} '
                f'durs={durs} trials={args.trials}')
    groups = []
    for strat in strategies:
        if strat not in STRATEGIES:
            log("WARN", f"unknown strategy {strat}; skipping")
            continue
        for dur in durs:
            rows = []
            for _ in range(args.trials):
                rows.append(await run_pulse(res, bridge, clip, dur, strat))
                await asyncio.sleep(0.25)
            groups.append((strat, strat, dur, rows))
            last = rows[-1]
            log("sweep", f"{strat:<15} dur={dur:6.0f}ms  "
                         f"stuck={sum(x.stuck for x in rows)}/{len(rows)}  "
                         f"rel(state)={_fmt(last.state_release_ms)}")
    _summarize(groups)


def _fmt(v: Optional[float]) -> str:
    return "  --  " if v is None else f"{v:6.1f}"


def _print_pulse(i: int, r: PulseResult):
    log("pulse", f"#{i:<2} dur={r.duration_ms:6.0f}ms {r.strategy:<14} "
                 f"conn(st/vis)={_fmt(r.state_connect_ms)}/{_fmt(r.visual_connect_ms)} "
                 f"rel(st/vis)={_fmt(r.state_release_ms)}/{_fmt(r.visual_release_ms)} "
                 f"{'STUCK' if r.stuck else ''}")


def _median(xs: List[float]) -> Optional[float]:
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def _summarize(groups):
    print("\n=== SUMMARY " + "=" * 66)
    print(f"{'strategy':<16}{'dur(ms)':>9}{'stuck':>8}"
          f"{'rel-state med':>15}{'rel-vis med':>14}")
    print("-" * 78)
    for _, strat, dur, rows in groups:
        stuck = sum(r.stuck for r in rows)
        rs = _median([r.state_release_ms for r in rows])
        rv = _median([r.visual_release_ms for r in rows])
        print(f"{strat:<16}{dur:>9.0f}{stuck:>4}/{len(rows):<3}"
              f"{_fmt(rs):>15}{_fmt(rv):>14}")
    print("=" * 78 + "\n")


# --------------------------------------------------------------------------- #
# Self-test — validate the NBPV/NBPC codec with no network.
# --------------------------------------------------------------------------- #

def build_nbpv(key: str, trace: str, w: int, h: int, rgba: bytes) -> bytes:
    kb = key.encode(); ib = trace.encode()
    hdr = b"NBPV" + bytes([2, 1]) + struct.pack("<HHHH", len(kb), len(ib), w, h)
    return hdr + kb + ib + rgba


def mode_selftest():
    w, h = 4, 4
    blue = bytes([10, 20, 200, 255]) * (w * h)
    frame = build_nbpv("k", "inst_thumb:k", w, h, blue)
    dec = decode_nbpv(frame)
    assert dec is not None, "decode failed"
    trace, dw, dh, px = dec
    assert (trace, dw, dh) == ("inst_thumb:k", w, h), dec
    label, rgb = classify(px, dw, dh)
    assert label == "blue", (label, rgb)
    # chunking round-trip through the reassembler
    reasm = NbpcReassembler()
    mid = len(frame) // 2
    parts = [frame[:mid], frame[mid:]]
    c0 = b"NBPC" + struct.pack("<IHH", 7, 0, 2) + parts[0]
    c1 = b"NBPC" + struct.pack("<IHH", 7, 1, 2) + parts[1]
    assert reasm.feed(c1) is None
    out = reasm.feed(c0)
    assert out == frame, "reassembly mismatch"
    red = bytes([220, 10, 10, 255]) * (w * h)
    assert classify(red, w, h)[0] == "red"
    assert classify(bytes([0, 0, 0, 255]) * (w * h), w, h)[0] == "black"
    print("selftest OK — NBPV decode, classify(red/blue/black), NBPC reassembly")


# --------------------------------------------------------------------------- #

async def async_main(args):
    res = ResolumeClient(args.resolume)
    await res.connect()
    try:
        await asyncio.wait_for(res.ready.wait(), 5.0)
    except asyncio.TimeoutError:
        log("FATAL", f"no composition from Resolume at {args.resolume}. "
                     f"Is Resolume running with its WebSocket server on?")
        return

    bridge = None
    if not args.no_bridge:
        bridge = BridgeClient(args.bridge, args.thumb_w, args.thumb_h)
        try:
            await bridge.connect(args.barrel_key)
        except Exception as e:
            log("BRIDGE", f"connect failed ({e}); continuing state-only")
            bridge = None
        if bridge is not None:
            # give the first thumbnail a moment to arrive
            await asyncio.sleep(0.5)

    try:
        if args.mode == "monitor":
            await mode_monitor(res, bridge, args)
        elif args.mode == "pulse":
            await mode_pulse(res, bridge, args)
        elif args.mode == "sweep":
            await mode_sweep(res, bridge, args)
    finally:
        if bridge is not None:
            try:
                await bridge.stop_preview()
            except Exception:
                pass


def main():
    ap = argparse.ArgumentParser(description="Resolume sticky-piano-trigger latency spike")
    ap.add_argument("mode", choices=["monitor", "pulse", "sweep", "selftest"])
    ap.add_argument("--resolume", default=os.environ.get(
        "NANO_RESOLUME_URL", "ws://127.0.0.1:8080/api/v1"))
    ap.add_argument("--bridge", default="ws://localhost:" +
                    os.environ.get("NANO_BRIDGE_PORT", "8081"))
    ap.add_argument("--no-bridge", action="store_true",
                    help="skip the thumbnail channel; measure state only")
    ap.add_argument("--barrel-key", default=None,
                    help="explicit /global/plugins key of the empty barrel")
    ap.add_argument("--clip-red", default="Red")
    ap.add_argument("--clip-blue", default="Blue")
    ap.add_argument("--thumb-w", type=int, default=64)
    ap.add_argument("--thumb-h", type=int, default=36)
    # pulse
    ap.add_argument("--dur", type=float, default=120.0, help="gate length ms")
    ap.add_argument("--strategy", default="reconcile_sub", choices=list(STRATEGIES))
    ap.add_argument("--trials", type=int, default=5)
    # sweep
    ap.add_argument("--strategies", default="single,reconcile_sub,reconcile_poll")
    ap.add_argument("--durs", default="500,300,200,120,80,50,30")
    args = ap.parse_args()

    if args.mode == "selftest":
        mode_selftest()
        return
    try:
        asyncio.run(async_main(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
