# nano_diag — Windows diagnostics in one .exe

A single executable you can hand to somebody who has a Windows machine.
They double-click it, wait a few minutes, and send back one `.log`.

It exists because of one file. `src/plugin/nano_barrel/interop_texture_d3d11.cpp`
— the `WGL_NV_DX_interop2` share that *is* the Windows barrel — shipped having
never executed a single line, and it cannot execute under CrossOver at all:
there, OpenGL and Direct3D 11 are two unrelated translation layers over Metal,
with no shared-resource path between them, so `wglDXOpenDeviceNV` can never
succeed no matter what we write. Everything either side of that seam is covered
by `tests/test_barrel_render.cpp`. The seam needs a real driver.

Everything else in here is context for reading that one result. An interop
failure means one thing on a 2016 driver, another on a hybrid laptop where GL
and D3D land on different GPUs, and another again over remote desktop — and the
only way to tell them apart from a log someone emailed you is to have written
the machine down first.

## Building and packaging

```bash
native/tools/nano_diag/package.sh          # -> <repo>/dist/nano-diag-<date>.zip
```

That builds the cross-compiled tree, stages the plugin, the shared runtime, the
effect bundles, the fonts and a curated set of Catch2 suites into one folder in
the layout `platform/resource_root.h` recognises, and zips it. Nothing in the
zip needs installing or configuring.

To build just the tool:

```bash
cmake --build native/build-win --target nano_diag   # needs -DNANO_BUILD_FFGL=ON
```

## Running it

```
nano_diag.exe                 run everything, write nano-diag-<stamp>.log beside the exe
nano_diag.exe --probe interop run one check in this process
nano_diag.exe --probes-only   skip the Catch2 suites
nano_diag.exe --only barrel   only checks whose name contains "barrel"
nano_diag.exe --strict        NANO_D3D_STRICT=1 (abort on a bad HRESULT)
nano_diag.exe --list          what there is to run
```

`NANO_D3D_ADAPTER` is inherited by every child, so a hybrid-GPU machine can be
re-run on the other GPU without a new build:

```
set NANO_D3D_ADAPTER=nvidia
nano_diag.exe --only interop
```

The driver runs **every check as a child process** — its own probes by
re-executing itself with `--probe`, the suites as they are. That is not
ceremony: the headline check is code running for the first time anywhere, and
"it crashed" is a perfectly good answer that must not take the rest of the run
with it. A child turns an access violation into one `CRASH` line.

It also sets the children's environment so the zip works untouched:
`NANO_RESOURCE_ROOT`, `NANO_WASM_DIR` and `NANO_LIB_DIR` point at the folder,
and `NANO_BRIDGE_PORT` moves off 8081 so a run beside a live Resolume does not
fight it for the port.

## The checks

| probe | what it answers |
|---|---|
| `system` | Windows build, CPU, RAM, what is actually in the folder, where the resource root resolved to — and whether this is wine |
| `adapters` | every DXGI adapter with its driver version, which one the null-adapter `D3D11CreateDevice` picks, and whether 11_1 is available (11_0 caps compute UAVs at 8, and `line_reconstruct` binds u8/u9/u10) |
| `compiler` | which `d3dcompiler_47.dll` won, its version, and whether it compiles `RWByteAddressBuffer::InterlockedAdd` — the shape SPIRV-Cross emits for every storage buffer |
| `gl` | GL vendor/renderer/version, `glBlitFramebuffer`, and whether `WGL_NV_DX_interop2` is offered at all. Cross-checks the GL renderer against the adapter list, because a hybrid laptop with GL on one GPU and D3D on the other is the classic silent interop failure |
| `interop` | the share itself, both directions, plus the plugin's actual `glBlitFramebuffer` code shape. Describes what it finds rather than just asserting: a share that works but swaps red and blue, or flips the rows, is a different bug from one that fails to open |
| `barrel` | the plugin's whole frame with no FFGL in it — open the shared runtime, build the interop pair **on the runtime's own device**, push a frame in through GL, render, pull it back out through GL, and check the same pixels two ways |
| `ffgl` | the shipping `NanoBarrel.dll`, driven through `plugMain` with the real FFGL function codes, a GL input texture and a host FBO. If this passes it works in a host |

Then the Catch2 suites, cheapest signal first. The list is in `package.sh`:
everything there either asserts pixels — where a real AMD/NVIDIA/Intel driver
can legitimately disagree with the macOS goldens in a way wined3d-over-Metal
never will — or exercises something CrossOver fakes. The platform-neutral
suites prove nothing new on a different GPU and are left behind.

## Reading a log

The summary at the end repeats every `##FACT` line the probes emitted, so the
machine, its driver and the interop verdict are together in one place. Then one
line per check.

A `FAIL` on `gl` cascades into `interop`, `barrel` and `ffgl` — four failures,
one cause. Each says so in its own words; read the first one.

## What the first real machine said

Run on 2026-09-19: Windows 10.0.26200, i7-9750H, an Intel UHD 630 **and** an
NVIDIA Quadro RTX 5000, driver 26.20.100.7985.

**The share works.** `WGL_NV_DX_interop2` present; `createInteropTexture`
registered and the FBO came up complete; both directions carried the right
pixels with the right channels; `barrel` rendered a frame GL-in/GL-out with the
GL and D3D readbacks agreeing; and `ffgl` drove the shipping `NanoBarrel.dll`
through `plugMain` for 60 frames with the input surviving the round trip.
`interop_texture_d3d11.cpp` is no longer unproven code.

Four things that run gave wrong answers, and all four are now fixed:

1. **The interop probe's own orientation expectation was inverted** — it
   reported UPSIDE DOWN for a stack that was correct, which the `ffgl` probe's
   orientation check contradicted in the same run. There is no second Y
   reversal to cancel the blit's: "GL row 0 is the bottom" is a coordinate
   convention, not a flip. The check now asks the question with an absolute
   reference — does D3D row 0 hold the *top* of the host image.
2. **Text rendered nothing.** The fallback primary face was one hardcoded
   macOS path. Under CrossOver that quietly resolved through wine's `Z:` drive
   to the host Mac's Helvetica, so the text tests looked healthy here while the
   same binary on real Windows found no font at all. It now falls back to the
   bundled `default.ttf` — which is also what the plugin installs, so a tool
   and the plugin agree on one face. (The plugin was never affected: it always
   passed an explicit path.)
3. **`CreateBuffer` rejected three 4-byte storage buffers** with `E_INVALIDARG`
   where every larger one succeeded. wined3d accepts the flag set at any size;
   that driver does not. The backend now walks a ladder of progressively
   smaller flag sets and logs which one the driver took — the next log names
   the rule.
4. **`nano_diag` was gated on `NANO_BUILD_FFGL` but not `WIN32`**, so it broke
   the macOS build as soon as that option was on.

**The open question is which GPU.** The engine builds its device with
`D3D11CreateDevice(nullptr, ...)` — the default adapter, which on that laptop
is the Intel. `nano_diag` is an unknown executable, so its GL context landed on
the Intel too and the two matched by luck. Inside Resolume, whose driver
profile almost certainly puts GL on the Quadro, they would not, and the share
requires both on the same GPU. The `interop` probe now builds a device on every
hardware adapter and reports which ones the live GL context will actually open,
which settles it; `NANO_D3D_ADAPTER` (a DXGI index, or a fragment of the
description such as `nvidia`) is the escape hatch in the meantime.

## What it does not do

No `ffgl_runner`-style benchmarking, no Live mode, no MIDI (`midi_host_null.cpp`
is still the WinMM seam), no Art-Net. It installs nothing, writes only into its
own folder, and does not touch Resolume.
