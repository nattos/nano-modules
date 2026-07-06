#!/usr/bin/env python3
"""
piano_mock_resolume.py — a tiny mock of Resolume's WS API for developing
piano_spike.py OFFLINE (no Resolume, no bridge).

It speaks the subset piano_spike uses:
  * on connect, pushes a full composition (2 layers; clips "Red"=Normal,
    "Blue"=Piano), each clip carrying a `connected` ParamState with an id;
  * `subscribe` /parameter/by-id/<id> -> `parameter_subscribed` with the value;
  * `trigger` .../connect true|false -> updates that clip's connected state
    after a small processing latency and pushes `parameter_update` to everyone.

The point of interest is --stick: a heuristic stand-in for Resolume's real
sticky-piano bug so the bench's stuck-detection and reconcile strategies show a
measurable difference. When a Piano clip receives a DISCONNECT within
--stick-window ms of its connect, the disconnect is DROPPED with probability
--stick (the fast on/off race). A later resend that lands outside the window
succeeds — which is exactly why reconcile-with-resend recovers. This is a
plausible model, NOT a validated reproduction; use it only to shake out the
harness, then point piano_spike at real Resolume.

    python3 -m venv /tmp/piano-spike-venv
    /tmp/piano-spike-venv/bin/pip install websockets
    /tmp/piano-spike-venv/bin/python native/tools/piano_mock_resolume.py --port 8080 --stick 0.7
    # then, in another shell:
    /tmp/piano-spike-venv/bin/python native/tools/piano_spike.py --no-bridge \
        --resolume ws://127.0.0.1:8080/ sweep
"""

import argparse
import asyncio
import json
import random
import time

import websockets

CLIPS = [
    # (layer_idx, clip_idx, name, triggerstyle, connected_id)
    (0, 0, "Red", "Normal", 5001),
    (1, 0, "Blue", "Piano", 5002),
]


class Mock:
    def __init__(self, args):
        self.args = args
        self.clients = set()
        self.state = {cid: "Disconnected" for *_, cid in CLIPS}
        self.connect_ms = {cid: 0.0 for *_, cid in CLIPS}
        self.style = {cid: st for *_, st, cid in
                      [(0, 0, "Red", "Normal", 5001), (0, 0, "Blue", "Piano", 5002)]}
        self._by_path = {}   # /composition/layers/L/clips/C/connect -> cid
        for li, ci, name, st, cid in CLIPS:
            self._by_path[f"/composition/layers/{li+1}/clips/{ci+1}/connect"] = cid
            self.style[cid] = st

    def composition(self):
        layers = []
        by_layer = {}
        for li, ci, name, st, cid in CLIPS:
            by_layer.setdefault(li, [])
            by_layer[li].append((ci, name, st, cid))
        for li in sorted(by_layer):
            clips = []
            for ci, name, st, cid in sorted(by_layer[li]):
                clips.append({
                    "id": 9000 + cid,
                    "name": {"valuetype": "ParamString", "id": 8000 + cid, "value": name},
                    "connected": {"valuetype": "ParamState",
                                  "options": ["Empty", "Disconnected", "Previewing",
                                              "Connected", "Connected & previewing"],
                                  "value": self.state[cid], "id": cid},
                    "triggerstyle": {"valuetype": "ParamChoice",
                                     "options": ["Composition Determined", "Normal",
                                                 "Piano", "Toggle"], "value": st},
                })
            layers.append({"id": 100 + li,
                           "name": {"valuetype": "ParamString", "value": f"Layer {li+1}"},
                           "clips": clips})
        return {"name": {"valuetype": "ParamString", "value": "Mock Comp"},
                "layers": layers}

    async def handler(self, ws):
        self.clients.add(ws)
        await ws.send(json.dumps(self.composition()))
        try:
            async for raw in ws:
                try:
                    j = json.loads(raw)
                except Exception:
                    continue
                await self.on_msg(j)
        except websockets.exceptions.ConnectionClosed:
            pass  # normal client teardown
        finally:
            self.clients.discard(ws)

    async def on_msg(self, j):
        action = j.get("action")
        if action == "subscribe":
            param = j.get("parameter", "")
            if param.startswith("/parameter/by-id/"):
                cid = int(param.rsplit("/", 1)[-1])
                if cid in self.state:
                    await self.broadcast({"type": "parameter_subscribed", "id": cid,
                                          "valuetype": "ParamState",
                                          "value": self.state[cid],
                                          "path": param})
        elif action == "trigger":
            cid = self._by_path.get(j.get("parameter", ""))
            if cid is not None:
                asyncio.create_task(self.apply_trigger(cid, bool(j.get("value"))))

    async def apply_trigger(self, cid, on):
        # processing latency
        await asyncio.sleep(self.args.latency / 1000.0)
        now = time.perf_counter() * 1000.0
        if on:
            new = "Connected"
            self.connect_ms[cid] = now
        else:
            # sticky-piano model: fast disconnect after connect may be dropped.
            if self.style[cid] == "Piano":
                since = now - self.connect_ms[cid]
                if since < self.args.stick_window and random.random() < self.args.stick:
                    return  # dropped — clip stays Connected (stuck)
            new = "Disconnected"
        if self.state[cid] == new:
            return
        self.state[cid] = new
        await self.broadcast({"type": "parameter_update", "id": cid,
                              "valuetype": "ParamState", "value": new,
                              "path": f"/parameter/by-id/{cid}"})

    async def broadcast(self, obj):
        msg = json.dumps(obj)
        for ws in list(self.clients):
            try:
                await ws.send(msg)
            except Exception:
                self.clients.discard(ws)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--latency", type=float, default=8.0,
                    help="per-trigger processing latency ms")
    ap.add_argument("--stick", type=float, default=0.7,
                    help="prob a fast piano disconnect is dropped (0..1)")
    ap.add_argument("--stick-window", type=float, default=150.0,
                    help="ms after connect within which disconnects can stick")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()
    random.seed(args.seed)
    mock = Mock(args)
    print(f"mock Resolume on ws://127.0.0.1:{args.port}/  "
          f"stick={args.stick} window={args.stick_window}ms latency={args.latency}ms")
    async with websockets.serve(mock.handler, "127.0.0.1", args.port, max_size=None):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
