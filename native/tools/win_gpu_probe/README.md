# Windows GPU probes

Three tiny console programs that answer "can this Windows environment actually
run what we need?", without a Windows SDK, MSVC, or a Windows machine to build
on. They were written to work out whether CrossOver's failure to run the app was
a CrossOver limitation or a Chromium one — it is a Chromium one. See the
CrossOver section of `DESKTOP.md` for the results and what they mean.

```bash
brew install zig          # the only dependency
./build.sh /tmp/probes    # cross-compiles three .exe from macOS
```

| Probe | Asks |
|---|---|
| `d3d11_test` | D3D11 device, compute (groupshared + barriers + reduction + UAV atomics), rasterize a triangle offscreen, read it back |
| `d3d12_test` | The same through D3D12, plus binding tier / shader model / wave ops — the D3D12 feature set Dawn needs for WebGPU |
| `chromium_reqs` | What Chromium needs *beyond* plain D3D: a BGRA device, `ID3D11Device5`, shared NT handles (`IDXGIResource1::CreateSharedHandle`) and DirectComposition |

All three are **headless on purpose** — no window, no swapchain, no present.
Everything renders to an offscreen RTV and is verified by reading pixels and
buffers back. That is what separates "the GPU works" from "Windows desktop
integration works", which is exactly the distinction that mattered.

Under wine/CrossOver, force Microsoft's HLSL compiler, because wine's builtin
one rejects perfectly valid shaders (e.g. `RWByteAddressBuffer::InterlockedAdd`)
and the failure looks like a GPU problem:

```bash
cp "<bottle>/drive_c/<app>/d3dcompiler_47.dll" <probe dir>/
WINEDLLOVERRIDES="d3dcompiler_47=n" wine --bottle <bottle> --cx-app 'C:\...\d3d11_test.exe'
```

The D3D12 probe compiles to **shader model 5.1 DXBC**, which the D3D12 runtime
accepts natively, rather than DXIL — DXIL must be signed by `dxil.dll`, and an
unsigned blob would fail for reasons unrelated to the question being asked.
