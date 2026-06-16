# wamrc — WAMR AOT compiler (local tooling, not committed)

Used to produce optional per-bundle/per-arch `.aot` sidecars for effect bundles
(see `native/wasm_modules/executor/build_aot.sh`). AOT is a *speed bonus*: the
portable `.wasm` is always the fallback, so this tooling is build-time only and
never ships to users.

## Setup (macOS, one-time)

1. Download the prebuilt compiler from the WAMR release matching our runtime
   (currently WAMR-2.2.0). Only an x86_64 macOS build is published; it runs under
   Rosetta and cross-compiles `.aot` for any arch via `--target`:

       curl -sL -o wamrc.tar.gz \
         https://github.com/bytecodealliance/wasm-micro-runtime/releases/download/WAMR-2.2.0/wamrc-2.2.0-x86_64-macos-13.tar.gz
       tar xzf wamrc.tar.gz && rm wamrc.tar.gz

2. The prebuilt binary links an Intel-Homebrew `libzstd` that isn't on Apple
   Silicon. Build the tiny x86_64 stub (LLVM's optional compression; never
   invoked during AOT emission) and redirect wamrc at it:

       clang -arch x86_64 -dynamiclib -O2 -o libzstd.1.dylib \
         -install_name /usr/local/opt/zstd/lib/libzstd.1.dylib zstd_stub.c
       install_name_tool -change /usr/local/opt/zstd/lib/libzstd.1.dylib \
         @loader_path/libzstd.1.dylib wamrc

3. `./wamrc --version` should print `wamrc 2.2.0`.

`wamrc` (62 MB) and `libzstd.1.dylib` are gitignored; `zstd_stub.c` is the source.
