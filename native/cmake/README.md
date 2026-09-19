# Cross-compiling the native tree to Windows

There is no Windows machine in this loop. `zig` ships the mingw-w64 headers and
import libs, so a Windows x64 binary builds from macOS with no Windows SDK and
no MSVC — the same recipe `tools/win_gpu_probe/build.sh` already uses for the
D3D probes.

```bash
brew install zig          # the only dependency
```

## The Stage 0 smoke target

Proves the toolchain end to end — CMake drives zig, a real third-party library
(Catch2) cross-builds, the binary runs, and `platform/paths.h`'s `_WIN32`
branches do what they claim. Those branches were written before any Windows host
existed and had never once been executed.

```bash
cd native
cmake -B build-win-smoke -S cmake/smoke \
      -DCMAKE_TOOLCHAIN_FILE="$PWD/cmake/toolchain-win-zig.cmake"
cmake --build build-win-smoke -j8
```

Then under CrossOver (see DESKTOP.md for the bottle):

```bash
W=/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine
cp build-win-smoke/nano_win_smoke.exe "$HOME/Library/Application Support/CrossOver/Bottles/NanoModulesTest/drive_c/smoke/"
"$W" --bottle NanoModulesTest --cx-app 'C:\smoke\nano_win_smoke.exe' -s
```

It is deliberately a **standalone** CMake project: the main `CMakeLists.txt`
cannot configure off macOS yet (it declares `OBJCXX` at line 12), and the point
of this target is to retire the toolchain risk *before* touching that.

## What it confirmed

- `imagePathContaining` returns `C:\smoke\nano_win_smoke.exe` via
  `GetModuleHandleExW(FROM_ADDRESS)`. The entire `resource_root.h` search walk
  hangs off this, so an empty result would mean the plugin resolves no effects.
- `supportDirPath()` returns `C:\users\crossover\AppData\Roaming/NanoBarrel` —
  **the same directory the Electron install record already lands in**, computed
  by the two halves with neither told about the other.
- `-D__USE_MINGW_ANSI_STDIO=1` is load-bearing: mingw's default `printf` is
  MSVCRT's, which prints `%zu` and `%lld` as literal garbage. Several bridge and
  GPU files format sizes that way.
- `joinPath` always emits `/`, so Windows paths come out mixed
  (`C:\nano/wasm`). Harmless — Windows accepts both, and the editor's
  stale-plugin check folds separators before comparing
  (`web/src/state/resolume-setup.ts:297`).
