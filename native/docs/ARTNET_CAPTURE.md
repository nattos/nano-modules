# Art-Net capture — the contract between `beatsync` and nano

`beatsync` (audiooptim) sends drum-role triggers to Resolume as Art-Net. nano listens to the same
stream so those triggers can drive sketches **without taking them away from Resolume**. This
document is the wire contract between the two repos, kept here because we are the consumer.

Our side: `native/src/artnet/artnet_host.h` (the shipping listener, inside the shared-server
dylib), `native/wasm_modules/artnet_in/main.cpp` (the `control.artnet` effect), and
`web/src/vite-plugins/udp-bridge.ts` (a dev-server-only convenience).

---

## 1. Can two processes hear the same datagrams?

Yes, conditionally. Measured on macOS 25.5 against a live Resolume Arena:

| | result |
|---|---|
| Arena's socket | binds wildcard `*:6454`, **and sets `SO_REUSEPORT`** |
| our bind, plain or `SO_REUSEADDR` only | `EADDRINUSE` |
| our bind with `SO_REUSEPORT` | **succeeds; packets flow** |
| sender → subnet broadcast (`x.x.x.255`) | ✓ **Arena and we both receive** |
| sender → limited broadcast (`255.255.255.255`) | ✓ **both receive** |
| sender → unicast (LAN address or `127.0.0.1`) | ✗ delivered to **exactly one** socket |
| a socket bound to an interface address | ✗ does **not** receive subnet broadcast |

Four rules follow, and they are the whole design:

1. **Every socket on the port must set `SO_REUSEPORT`.** One participant without it and nobody
   else can bind. Arena sets it, which is the only reason any of this is possible.
2. **Only broadcast is shared.** A unicast frame goes to one socket, and which one is the kernel's
   PCB lookup, not a promise. In practice the first bound wins — so a listener that starts *after*
   Arena is starved rather than stealing, which is the right failure direction, but it is not a
   guarantee and inverts if Arena restarts.
3. **Bind wildcard, never an interface address.** An interface-bound socket looks like a working
   listener and silently hears no broadcast.
4. **A listener must never transmit.** No `ArtPollReply`, no discovery. This is what makes
   co-tenanting a live rig's control port safe: the worst case is that we hear nothing, never that
   Resolume does. Our listener sends nothing at all; the only transmitter in nano is the dev
   server's test-pattern generator, which is opt-in and absent from a production build.

### Platform note for the node side

Which node `dgram` option produces `SO_REUSEPORT` is platform-dependent and **the option names
mislead**. On Darwin libuv maps `reuseAddr` to `SO_REUSEADDR` *and* `SO_REUSEPORT` (BSD needs the
pair), and the separate `reusePort` option — a newer Linux load-balancing feature — throws
`ENOTSUP`. On Linux the reverse holds. Ask for `reusePort`, fall back to `reuseAddr`; don't reason
from the name.

---

## 2. What we would like from `beatsync`

### 2.1 `--artnet-mirror <host[:port]>` — the ask that matters

Send every frame the refresh loop already sends to the active destination **also** to a second,
fixed destination. Default port **6455** (`artnet::kMirrorPort` on our side, which listens there
alongside 6454).

Cheap to build: `g_artnetSock[AN_MAX]` (`v3_live.mm:143`) is already an array of pre-connected
sockets and `[O]` only moves an index. The mirror is one more index plus a second `send()` in
`artnetLoop`. At 4 channels / 100 Hz it is ~2.2 KB/s.

**`prepareBlackout` / `sendBlackout` must cover the mirror too.** A mirror latched on at exit is
the same bug as a latched main destination, and twice as invisible — nobody is looking at the
second destination when something sticks.

**Why it matters even though broadcast works.** Broadcast capture depends on two things nobody
will remember at showtime: which destination `[O]` happens to be on, and Resolume continuing to
set `SO_REUSEPORT`. The mirror removes both. It is the difference between "capture is a
configuration people can get wrong" and "capture is wired". It also makes unicast rigs — where
sharing is impossible — capturable.

### 2.2 Broadcast convention, for the no-mirror case

Destination must be **`<iface> bcast`** or **`all`**. On `lan` or `loop` we are silently starved.

Worth a menu warning: **unicast destination + something else already holding 6454** is
uncapturable, and the sending side cannot see it — `sent` climbs, `failed` stays 0, exactly as when
everything is fine. That is the same class of invisible failure the destination picker already
exists to solve.

### 2.3 Universe 1

Keep it. Resolume broadcasts its **own** Art-Net output back into its own input — there is no
obvious way to separate its output interface from its input interface — at roughly **500
packets/second** of full 512-channel frames plus `ArtSync`, on universe 0. Universe 1 is how
beatsync stays out of that. `control.artnet` therefore defaults to universe 1, not 0.

### 2.4 Optional, not asked for

An `ArtPollReply` carrying a short name would let listeners identify the source instead of
inferring it from frame shape. Nice, not needed — see §3.

---

## 3. The frame, as we consume it

```
opcode      0x5000 (ArtDmx), LITTLE endian on the wire
length      big endian, two bytes later — the header is genuinely mixed-endian
address     Net(7) | Subnet(4) | Universe(4); SubUni in the low byte, Net in the high
channels    4, DMX 1..4, universe 1
sequence    1..255, 0 = "sequencing disabled"
```

**Channel map — roles, not classes, in a fixed order:**

| DMX | role |
|---|---|
| 1 | heavy |
| 2 | regular |
| 3 | decor |
| 4 | uniform |

A role is what a voice is *doing* over time (density, bar-to-bar repetition, on-grid share,
spacing), not which drum a hit sounds like. `rawCls`/`cls` are not on the wire.

**Source discrimination is free**: beatsync's frames are 22 bytes with `dmxlen = 4`; Resolume's own
output is 530 bytes with `dmxlen = 512`. No name or poll is needed to tell them apart.

**Gate semantics.** A hit is a gate, not a note: the channel jumps to a velocity-derived brightness
and holds `g_artnetGateMs` (90 ms default) at `g_artnetDuty` (0.9), then falls to 0. Refresh is
100 Hz. Velocity passes through `g_artnetGain` (×2), because raw `TransEvent.level` tops out near
0.52 on real music and would otherwise be a channel that never exceeds half brightness.

Two consequences for the consumer, both of which nano relies on:

* **A 60 Hz sampler sees every gate.** 90 ms is ~5 frames; the duty pause is ~9 ms, one frame at
  100 Hz. No polling faster than the render rate is needed.
* **The 90 ms hold IS the decay envelope.** nano adds no smoothing of its own — a `control.artnet`
  channel is the sender's shape, verbatim, and any further shaping is the sketch's business.

**Silence is not blackout.** DMX carries only the current level, retransmitted forever, so a
universe that goes quiet keeps its last values on our side; we report `age_ms` rather than
inventing a decay. A universe never heard at all is different again: `control.artnet` injects
nothing and the card's authored values stand (the same dormant-source semantics an unseeded wire
rail has). Blackout is beatsync's to send, and it does.
