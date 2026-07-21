cmake_minimum_required(VERSION 3.16)

# Default to an optimized build. With no build type CMake compiles at -O0, which
# makes the shared runtime (libbridge_server.dylib — the barrel Arena dlopens)
# several times slower on the memcpy/STL-heavy preview send path. RelWithDebInfo
# (-O2 -g -DNDEBUG) keeps symbols for profiling. Override with -DCMAKE_BUILD_TYPE.
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE RelWithDebInfo CACHE STRING "Build type" FORCE)
  message(STATUS "No CMAKE_BUILD_TYPE set — defaulting to RelWithDebInfo (-O2 -g)")
endif()

project(nano-repatch-native LANGUAGES C CXX OBJCXX ASM)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OBJCXX_STANDARD 17)

# Silence macOS OpenGL deprecation warnings
add_compile_definitions(GL_SILENCE_DEPRECATION)

# --- Dependencies via FetchContent ---
include(FetchContent)

# nlohmann/json
FetchContent_Declare(
  nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG v3.11.3
  GIT_SHALLOW TRUE
)

# IXWebSocket
FetchContent_Declare(
  ixwebsocket
  GIT_REPOSITORY https://github.com/machinezone/IXWebSocket.git
  GIT_TAG v11.4.5
  GIT_SHALLOW TRUE
)

# Catch2 (for tests)
FetchContent_Declare(
  Catch2
  GIT_REPOSITORY https://github.com/catchorg/Catch2.git
  GIT_TAG v3.5.2
  GIT_SHALLOW TRUE
)

# Disable IXWebSocket TLS to avoid OpenSSL dependency
set(USE_TLS OFF CACHE BOOL "" FORCE)
set(IXWEBSOCKET_INSTALL OFF CACHE BOOL "" FORCE)

FetchContent_MakeAvailable(nlohmann_json ixwebsocket Catch2)

# --- WAMR (WebAssembly Micro Runtime) ---
# Only populate (download), do NOT add_subdirectory — we use runtime_lib.cmake directly
FetchContent_Declare(
  wamr
  GIT_REPOSITORY https://github.com/bytecodealliance/wasm-micro-runtime.git
  GIT_TAG WAMR-2.2.0
  GIT_SHALLOW TRUE
)
FetchContent_Populate(wamr)

# Configure WAMR. INTERP is always on (the portable .wasm path + the universal
# fallback). AOT *loading* is on by default (NANO_WASM_AOT): it lets the runtime
# load a per-arch `<bundle>-<arch>.aot` sidecar when present — produced at build
# time by build_aot.sh via wamrc — so CPU-heavy effects run at ~native speed. AOT
# adds only the loader (no LLVM in the runtime). The `.aot` is OPTIONAL: every
# bundle still ships its portable `.wasm`, and the bundle loader falls back to it
# when no matching `.aot` exists. (Fast JIT is x86-64-only → unusable on arm64;
# LLVM-JIT would link ~100MB LLVM; the EXECUTOR stays native — see migration notes.)
option(NANO_WASM_AOT "Build the WAMR runtime with AOT-module loading enabled" ON)
set(WAMR_ROOT_DIR ${wamr_SOURCE_DIR})
set(WAMR_BUILD_INTERP 1)
set(WAMR_BUILD_FAST_INTERP 1)
if(NANO_WASM_AOT)
  set(WAMR_BUILD_AOT 1)
else()
  set(WAMR_BUILD_AOT 0)
endif()
set(WAMR_BUILD_JIT 0)
set(WAMR_BUILD_FAST_JIT 0)
set(WAMR_BUILD_LIBC_BUILTIN 1)
set(WAMR_BUILD_LIBC_WASI 1)
set(WAMR_BUILD_SIMD 0)
# Reference types ON: modern clang emits the reference-types encoding for the
# indirect-function-table (call_indirect with a table-index immediate). The v2
# effect ABI is function-pointer-heavy (EffectDesc_v2 fn table → call_indirect),
# so effect bundles fail to load ("zero byte expected") without this.
set(WAMR_BUILD_REF_TYPES 1)
set(WAMR_BUILD_BULK_MEMORY 1)
set(WAMR_BUILD_PLATFORM "darwin")

include(${WAMR_ROOT_DIR}/build-scripts/runtime_lib.cmake)
add_library(vmlib STATIC ${WAMR_RUNTIME_LIB_SOURCE})
target_include_directories(vmlib PUBLIC ${WAMR_ROOT_DIR}/core/iwasm/include)
target_link_libraries(vmlib PUBLIC -lm -ldl ${CMAKE_THREAD_LIBS_INIT})

# --- SPIRV-Cross (runtime SPV→MSL for dynamically-loaded WASM effects) ---
# Effects load as WASM and ship SPIR-V, which must be translated to MSL at load
# time, so we link the library (spv_to_msl.cpp). Only core + glsl + msl are
# needed (CompilerMSL derives from CompilerGLSL).
set(SPIRV_CROSS_ENABLE_TESTS  OFF CACHE BOOL "" FORCE)
set(SPIRV_CROSS_CLI           OFF CACHE BOOL "" FORCE)
set(SPIRV_CROSS_ENABLE_HLSL   OFF CACHE BOOL "" FORCE)
set(SPIRV_CROSS_ENABLE_CPP    OFF CACHE BOOL "" FORCE)
set(SPIRV_CROSS_ENABLE_REFLECT OFF CACHE BOOL "" FORCE)
set(SPIRV_CROSS_ENABLE_C_API  OFF CACHE BOOL "" FORCE)
set(SPIRV_CROSS_ENABLE_UTIL   OFF CACHE BOOL "" FORCE)
set(SPIRV_CROSS_SKIP_INSTALL  ON  CACHE BOOL "" FORCE)
set(SPIRV_CROSS_FORCE_PIC     ON  CACHE BOOL "" FORCE)
FetchContent_Declare(
  spirv_cross
  GIT_REPOSITORY https://github.com/KhronosGroup/SPIRV-Cross.git
  GIT_TAG vulkan-sdk-1.4.341.0
  GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(spirv_cross)

# Runtime SPV→MSL helper (platform-agnostic; built everywhere).
add_library(spv_to_msl STATIC src/runtime/spv_to_msl.cpp)
target_include_directories(spv_to_msl PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(spv_to_msl PUBLIC spirv-cross-msl)

# --- FFGL SDK ---
set(FFGL_BUILD_EXAMPLE_PLUGINS OFF CACHE BOOL "" FORCE)
add_subdirectory(modules/ffgl)

# --- Canvas Renderer library ---
add_library(canvas_renderer STATIC
  src/canvas/canvas_renderer.cpp
  src/canvas/image_loader.mm
)
target_include_directories(canvas_renderer PUBLIC ${CMAKE_SOURCE_DIR}/src)
if(APPLE)
  target_link_libraries(canvas_renderer PUBLIC
    "-framework OpenGL"
    "-framework CoreGraphics"
    "-framework Foundation"
  )
endif()

# --- JSON utilities (Patch + Doc) ---
add_library(json_utils STATIC
  src/json/json_patch.cpp
  src/json/json_doc.cpp
)
target_include_directories(json_utils PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(json_utils PUBLIC nlohmann_json::nlohmann_json)

# --- State Document + Observer Registry ---
add_library(state_system STATIC
  src/bridge/state_document.cpp
  src/bridge/observer_registry.cpp
)
target_include_directories(state_system PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(state_system PUBLIC json_utils)

# --- Param Cache library ---
add_library(param_cache STATIC
  src/bridge/param_cache.cpp
)
target_include_directories(param_cache PUBLIC ${CMAKE_SOURCE_DIR}/src)

# --- Resolume Protocol + Composition library ---
add_library(resolume_protocol STATIC
  src/resolume/protocol.cpp
  src/resolume/composition.cpp
)
target_include_directories(resolume_protocol PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(resolume_protocol PUBLIC nlohmann_json::nlohmann_json)

# --- GPU Backend library ---
if(APPLE)
  add_library(gpu_backend STATIC
    src/gpu/metal_backend.mm
  )
  # metal_backend.mm is compiled under ARC — id members of the C++ backend
  # class (device/queue/encoders, the resource handle table, scratch pools)
  # are managed automatically. See the file header.
  target_compile_options(gpu_backend PRIVATE -fobjc-arc)
  target_include_directories(gpu_backend PUBLIC ${CMAKE_SOURCE_DIR}/src)
  target_link_libraries(gpu_backend PUBLIC
    "-framework Metal"
    "-framework MetalPerformanceShaders"
    "-framework Foundation"
  )
endif()

# --- WASM Host library ---
add_library(wasm_host STATIC
  src/wasm/wasm_host.cpp
  src/wasm/host_functions.cpp
  src/wasm/audio_bus.cpp
)
target_include_directories(wasm_host PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(wasm_host PUBLIC param_cache vmlib state_system)
if(APPLE)
  target_link_libraries(wasm_host PUBLIC gpu_backend)
endif()

# --- Resolume WS Client library ---
add_library(resolume_client STATIC
  src/resolume/ws_client.cpp
)
target_include_directories(resolume_client PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(resolume_client PUBLIC resolume_protocol ixwebsocket)

# --- Bridge WS Server library ---
add_library(bridge_ws_server STATIC
  src/bridge/ws_server.cpp
)
target_include_directories(bridge_ws_server PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(bridge_ws_server PUBLIC ixwebsocket)

# --- Bridge Core (platform-agnostic protocol engine) ---
add_library(bridge_core STATIC
  src/bridge/bridge_core.cpp
  src/bridge/bridge_core_api.cpp
)
target_include_directories(bridge_core PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(bridge_core PUBLIC state_system param_cache resolume_protocol nlohmann_json::nlohmann_json)

# --- miniz (vendored, public-domain zlib-subset) -------------------------
# Compresses the barrel's sketch config blob (barrel_codec.h). Native-only —
# the codec has no WASM target — so a compressor is fair game. Linked into
# every target that compiles a barrel_codec / channel_marker_codec user.
add_library(miniz STATIC third_party/miniz/miniz.c)
target_include_directories(miniz PUBLIC ${CMAKE_SOURCE_DIR}/third_party/miniz)
# We use only the mz_-prefixed API. Suppress miniz's zlib-compatible aliases
# (z_stream, crc32, …) so it can coexist in a TU that also includes the system
# <zlib.h> (e.g. ffgl_runner links system z). No stdio/archive features needed.
target_compile_definitions(miniz PUBLIC MINIZ_NO_ZLIB_COMPATIBLE_NAMES)

# --- Bridge Server shared library (dylib) ---
add_library(bridge_server SHARED
  src/bridge/bridge_server.cpp
  src/bridge/bridge_api.cpp
  src/bridge/composition_cache.cpp
  src/bridge/clip_launcher.cpp
  src/bridge/instance_locator.cpp
)
target_include_directories(bridge_server PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(bridge_server PRIVATE
  bridge_core
  resolume_client
  bridge_ws_server
  wasm_host
  nlohmann_json::nlohmann_json
)
# PUBLIC: consumers include barrel_codec.h (via src/) which needs miniz.h, so the
# include dir + symbols must propagate to anything linking bridge_server (the
# e2e tests that compile fake_resolume_server.cpp).
target_link_libraries(bridge_server PUBLIC miniz)

# --- Tests ---
include(CTest)
include(Catch)

add_executable(test_param_cache tests/test_param_cache.cpp)
target_link_libraries(test_param_cache PRIVATE param_cache Catch2::Catch2WithMain)
catch_discover_tests(test_param_cache)

add_executable(test_protocol tests/test_protocol.cpp)
target_link_libraries(test_protocol PRIVATE resolume_protocol Catch2::Catch2WithMain)
catch_discover_tests(test_protocol)

add_executable(test_bridge_api tests/test_bridge_api.cpp)
target_link_libraries(test_bridge_api PRIVATE bridge_server Catch2::Catch2WithMain)
catch_discover_tests(test_bridge_api)

# audio_bus is dependency-free (just <mutex>/<vector>), so compile it straight
# into the test rather than dragging in wasm_host + WAMR.
add_executable(test_audio_bus tests/test_audio_bus.cpp src/wasm/audio_bus.cpp)
target_include_directories(test_audio_bus PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_audio_bus PRIVATE Catch2::Catch2WithMain)
catch_discover_tests(test_audio_bus)

# Bridge loader library (for tests and harness — not linked to FFGL)
add_library(bridge_loader STATIC
  src/plugin/bridge_loader.cpp
)
target_include_directories(bridge_loader PUBLIC ${CMAKE_SOURCE_DIR}/src)

# Pass built dylib path to bridge loader test
add_executable(test_bridge_loader tests/test_bridge_loader.cpp)
target_link_libraries(test_bridge_loader PRIVATE bridge_loader Catch2::Catch2WithMain)
target_compile_definitions(test_bridge_loader PRIVATE
  BRIDGE_DYLIB_PATH="$<TARGET_FILE:bridge_server>"
)

catch_discover_tests(test_bridge_loader)

add_executable(test_wasm_host tests/test_wasm_host.cpp)
target_link_libraries(test_wasm_host PRIVATE wasm_host Catch2::Catch2WithMain)
target_compile_definitions(test_wasm_host PRIVATE
  FIXTURE_PATH="${CMAKE_SOURCE_DIR}/fixtures/"
)
catch_discover_tests(test_wasm_host)

add_executable(test_composition_cache tests/test_composition_cache.cpp
  src/bridge/composition_cache.cpp src/resolume/composition.cpp)
target_include_directories(test_composition_cache PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_composition_cache PRIVATE miniz nlohmann_json::nlohmann_json Catch2::Catch2WithMain)
catch_discover_tests(test_composition_cache)

# NanoLooper Ch scene-marker: nanoch:// config codec + CompositionCache decode.
add_executable(test_channel_marker tests/test_channel_marker.cpp
  src/bridge/composition_cache.cpp src/resolume/composition.cpp)
target_include_directories(test_channel_marker PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_channel_marker PRIVATE miniz nlohmann_json::nlohmann_json Catch2::Catch2WithMain)
catch_discover_tests(test_channel_marker)

# Barrel config codec: uuid-plaintext + zlib(sketch) form, legacy compat.
add_executable(test_barrel_codec tests/test_barrel_codec.cpp)
target_include_directories(test_barrel_codec PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_barrel_codec PRIVATE miniz nlohmann_json::nlohmann_json Catch2::Catch2WithMain)
catch_discover_tests(test_barrel_codec)

add_executable(test_instance_locator tests/test_instance_locator.cpp
  src/bridge/instance_locator.cpp)
target_include_directories(test_instance_locator PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_instance_locator PRIVATE state_system miniz nlohmann_json::nlohmann_json Catch2::Catch2WithMain)
catch_discover_tests(test_instance_locator)

# Process-global trigger rail bus (emit/drain seq-gating, metadata version).
# Compiles the bus source directly — it depends only on nlohmann_json.
add_executable(test_trigger_bus tests/test_trigger_bus.cpp
  src/sketch/trigger_bus.cpp)
target_include_directories(test_trigger_bus PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_trigger_bus PRIVATE nlohmann_json::nlohmann_json Catch2::Catch2WithMain)
catch_discover_tests(test_trigger_bus)

# Clip launcher reconcile/debounce logic (the piano-trigger stuck-on fix).
add_executable(test_clip_launcher tests/test_clip_launcher.cpp
  src/bridge/clip_launcher.cpp src/sketch/trigger_bus.cpp)
target_include_directories(test_clip_launcher PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_clip_launcher PRIVATE nlohmann_json::nlohmann_json Catch2::Catch2WithMain)
catch_discover_tests(test_clip_launcher)

# val host-ABI handle lifecycle: set/push must consume child handles so a
# per-frame published tree doesn't leak and wedge the executor (header-only).
add_executable(test_val_handles tests/test_val_handles.cpp)
target_include_directories(test_val_handles PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_val_handles PRIVATE nlohmann_json::nlohmann_json Catch2::Catch2WithMain)
catch_discover_tests(test_val_handles)

# Tap-mod range remapper + summation math (header-only; lock-step with web).
add_executable(test_tap_mod tests/test_tap_mod.cpp)
target_include_directories(test_tap_mod PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_tap_mod PRIVATE Catch2::Catch2WithMain)
catch_discover_tests(test_tap_mod)

# fx::SkipJog — shared C2 "skip empty" engagement ramp (effect_utils.h).
add_executable(test_skip_jog tests/test_skip_jog.cpp)
target_include_directories(test_skip_jog PRIVATE ${CMAKE_SOURCE_DIR}/wasm_modules/include)
target_link_libraries(test_skip_jog PRIVATE Catch2::Catch2WithMain)
catch_discover_tests(test_skip_jog)

add_executable(test_param_smoothing tests/test_param_smoothing.cpp)
target_include_directories(test_param_smoothing PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_param_smoothing PRIVATE Catch2::Catch2WithMain)
catch_discover_tests(test_param_smoothing)

# MFT MIDI driver — lock-step goldens shared with web/src/midi/drivers/mft.test.ts.
add_executable(test_mft_driver tests/test_mft_driver.cpp)
target_include_directories(test_mft_driver PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_mft_driver PRIVATE nlohmann_json::nlohmann_json Catch2::Catch2WithMain)
target_compile_definitions(test_mft_driver PRIVATE
  MFT_GOLDENS_PATH="${CMAKE_SOURCE_DIR}/tests/fixtures/mft_goldens.json")
catch_discover_tests(test_mft_driver)

add_executable(test_delay_line tests/test_delay_line.cpp)
target_include_directories(test_delay_line PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_delay_line PRIVATE Catch2::Catch2WithMain)
catch_discover_tests(test_delay_line)

add_executable(test_envelope tests/test_envelope.cpp)
target_include_directories(test_envelope PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_envelope PRIVATE Catch2::Catch2WithMain)
catch_discover_tests(test_envelope)

add_executable(test_transient_shaper tests/test_transient_shaper.cpp)
target_include_directories(test_transient_shaper PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_transient_shaper PRIVATE Catch2::Catch2WithMain)
catch_discover_tests(test_transient_shaper)

# Composition-executor timing/gate ports (src/sketch/comp/, header-only) —
# replays the shared goldens generated by the TS reference
# (web/.../engine/comp-goldens.test.ts, UPDATE_GOLDENS=1).
add_executable(test_comp_time tests/test_comp_time.cpp)
target_include_directories(test_comp_time PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_compile_definitions(test_comp_time PRIVATE
  COMP_FIXTURES_DIR="${CMAKE_SOURCE_DIR}/tests/fixtures/comp")
target_link_libraries(test_comp_time PRIVATE nlohmann_json::nlohmann_json Catch2::Catch2WithMain)
catch_discover_tests(test_comp_time)

# Composition-executor document/tree-eval/sketch-build ports — deep-equal JSON
# parity against the TS-generated build.json golden.
add_executable(test_comp_build tests/test_comp_build.cpp)
target_include_directories(test_comp_build PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_compile_definitions(test_comp_build PRIVATE
  COMP_FIXTURES_DIR="${CMAKE_SOURCE_DIR}/tests/fixtures/comp")
target_link_libraries(test_comp_build PRIVATE nlohmann_json::nlohmann_json Catch2::Catch2WithMain)
catch_discover_tests(test_comp_build)

# Shared spectral-morph curve generator (reused by mod.source.spectral_lfo +
# mod.shaper.spectral). Compiles standalone (no wasm host deps); pulls in the 1.2MB atlas.
add_executable(test_spectral_curve tests/test_spectral_curve.cpp
               ${CMAKE_SOURCE_DIR}/wasm_modules/spectral_lfo/spectral_curve.cpp)
target_include_directories(test_spectral_curve PRIVATE
               ${CMAKE_SOURCE_DIR}/wasm_modules/spectral_lfo)
target_link_libraries(test_spectral_curve PRIVATE Catch2::Catch2WithMain)
catch_discover_tests(test_spectral_curve)

add_executable(test_canvas_host tests/test_canvas_host.cpp)
target_link_libraries(test_canvas_host PRIVATE wasm_host Catch2::Catch2WithMain)
catch_discover_tests(test_canvas_host)

# Runtime SPV→MSL translation (barrel-loads-WASM). Uses a build-time .spv.
if(EXISTS "${CMAKE_SOURCE_DIR}/build/tmp/brightness_contrast_compute.spv")
  add_executable(test_spv_to_msl tests/test_spv_to_msl.cpp)
  target_link_libraries(test_spv_to_msl PRIVATE spv_to_msl Catch2::Catch2WithMain)
  target_compile_definitions(test_spv_to_msl PRIVATE
    BRIGHTNESS_SPV_PATH="${CMAKE_SOURCE_DIR}/build/tmp/brightness_contrast_compute.spv")
  catch_discover_tests(test_spv_to_msl)
endif()

# Effect v2 ABI load path (barrel-loads-WASM migration). Requires testonly.wasm
# (bundles mod.source.lfo) to be built into ../build/wasm.
if(EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/testonly.wasm")
  add_executable(test_effect_abi tests/test_effect_abi.cpp)
  target_link_libraries(test_effect_abi PRIVATE wasm_host Catch2::Catch2WithMain)
  target_compile_definitions(test_effect_abi PRIVATE
    TESTONLY_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/testonly.wasm"
  )
  catch_discover_tests(test_effect_abi)
endif()

# NanoLooper sequencer core — pure logic (records gate duration + optional
# quantize), compiled natively straight from the wasm module source.
add_executable(test_looper_core
  tests/test_looper_core.cpp
  wasm_modules/nanolooper/core.cpp)
target_link_libraries(test_looper_core PRIVATE Catch2::Catch2WithMain)
catch_discover_tests(test_looper_core)

# NanoLooper WASM module integration test (requires nanolooper.wasm to be built)
if(EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/nanolooper.wasm")
  add_executable(test_nanolooper_wasm tests/test_nanolooper_wasm.cpp)
  target_link_libraries(test_nanolooper_wasm PRIVATE wasm_host Catch2::Catch2WithMain)
  target_compile_definitions(test_nanolooper_wasm PRIVATE
    NANOLOOPER_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/nanolooper.wasm"
  )
  catch_discover_tests(test_nanolooper_wasm)
endif()

# GPU→CPU buffer readback (backend readBuffer) — no WASM module needed.
if(APPLE)
  add_executable(test_gpu_readback tests/test_gpu_readback.mm)
  target_link_libraries(test_gpu_readback PRIVATE
    gpu_backend Catch2::Catch2WithMain
    "-framework Metal" "-framework Foundation"
  )
  catch_discover_tests(test_gpu_readback)
endif()

# Metal GPU pipeline test
if(APPLE AND EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/gpu_test.wasm")
  add_executable(test_gpu_metal tests/test_gpu_metal.mm)
  target_link_libraries(test_gpu_metal PRIVATE
    wasm_host gpu_backend Catch2::Catch2WithMain
    "-framework Metal" "-framework Foundation"
  )
  target_compile_definitions(test_gpu_metal PRIVATE
    GPU_TEST_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/gpu_test.wasm"
  )
  catch_discover_tests(test_gpu_metal)
endif()

add_executable(test_json_patch tests/test_json_patch.cpp)
target_link_libraries(test_json_patch PRIVATE json_utils Catch2::Catch2WithMain)
catch_discover_tests(test_json_patch)

add_executable(test_json_doc tests/test_json_doc.cpp)
target_link_libraries(test_json_doc PRIVATE json_utils Catch2::Catch2WithMain)
catch_discover_tests(test_json_doc)

add_executable(test_observer_registry tests/test_observer_registry.cpp)
target_link_libraries(test_observer_registry PRIVATE state_system Catch2::Catch2WithMain)
catch_discover_tests(test_observer_registry)

add_executable(test_state_document tests/test_state_document.cpp)
target_link_libraries(test_state_document PRIVATE state_system Catch2::Catch2WithMain)
catch_discover_tests(test_state_document)

add_executable(test_state_integration tests/test_state_integration.cpp)
target_link_libraries(test_state_integration PRIVATE bridge_server ixwebsocket nlohmann_json::nlohmann_json Catch2::Catch2WithMain)
catch_discover_tests(test_state_integration PROPERTIES LABELS "integration")

add_executable(test_draw_list tests/test_draw_list.cpp)
target_include_directories(test_draw_list PRIVATE ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(test_draw_list PRIVATE Catch2::Catch2WithMain)
catch_discover_tests(test_draw_list)

add_executable(test_ws_server tests/test_ws_server.cpp)
target_link_libraries(test_ws_server PRIVATE bridge_ws_server ixwebsocket Catch2::Catch2WithMain)
catch_discover_tests(test_ws_server PROPERTIES LABELS "integration")

# End-to-end: real dylib (BridgeServer) ↔ fake Resolume server over a real WS.
add_executable(test_instance_locator_e2e
  tests/test_instance_locator_e2e.cpp
  tests/fake_resolume_server.cpp)
target_include_directories(test_instance_locator_e2e PRIVATE ${CMAKE_SOURCE_DIR}/src ${CMAKE_SOURCE_DIR}/tests)
target_link_libraries(test_instance_locator_e2e PRIVATE bridge_server ixwebsocket nlohmann_json::nlohmann_json Catch2::Catch2WithMain)
catch_discover_tests(test_instance_locator_e2e PROPERTIES LABELS "integration")

# End-to-end: rail trigger → BridgeServer pump → fake Resolume clip connect.
add_executable(test_clip_launcher_e2e
  tests/test_clip_launcher_e2e.cpp
  tests/fake_resolume_server.cpp)
target_include_directories(test_clip_launcher_e2e PRIVATE ${CMAKE_SOURCE_DIR}/src ${CMAKE_SOURCE_DIR}/tests)
target_link_libraries(test_clip_launcher_e2e PRIVATE bridge_server ixwebsocket nlohmann_json::nlohmann_json Catch2::Catch2WithMain)
catch_discover_tests(test_clip_launcher_e2e PROPERTIES LABELS "integration")

add_executable(test_trigger_channels_e2e
  tests/test_trigger_channels_e2e.cpp
  tests/fake_resolume_server.cpp)
target_include_directories(test_trigger_channels_e2e PRIVATE ${CMAKE_SOURCE_DIR}/src ${CMAKE_SOURCE_DIR}/tests)
target_link_libraries(test_trigger_channels_e2e PRIVATE bridge_server ixwebsocket nlohmann_json::nlohmann_json Catch2::Catch2WithMain)
catch_discover_tests(test_trigger_channels_e2e PROPERTIES LABELS "integration")

# Runnable fake Resolume WS server (headless dev/e2e — point the dylib at it via
# NANO_RESOLUME_URL).
add_executable(fake_resolume
  tools/fake_resolume.cpp
  tests/fake_resolume_server.cpp)
target_include_directories(fake_resolume PRIVATE ${CMAKE_SOURCE_DIR}/src ${CMAKE_SOURCE_DIR}/tests)
target_link_libraries(fake_resolume PRIVATE ixwebsocket miniz nlohmann_json::nlohmann_json)

# --- FFGL Plugin Bundle (macOS) ---
if(APPLE)
  set(FFGL_BUNDLE_LINK_FLAGS "-undefined dynamic_lookup")

  add_library(NanoRepatch MODULE
    src/plugin/repatch_plugin.cpp
    src/plugin/bridge_loader.cpp
  )
  target_include_directories(NanoRepatch PRIVATE ${CMAKE_SOURCE_DIR}/src)
  target_link_libraries(NanoRepatch PRIVATE
    ffgl::sdk
    "-framework OpenGL"
  )
  set_target_properties(NanoRepatch PROPERTIES
    BUNDLE TRUE
    BUNDLE_EXTENSION "bundle"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_SOURCE_DIR}/src/plugin/Info.plist.in"
    LINK_FLAGS "${FFGL_BUNDLE_LINK_FLAGS}"
  )

  # NanoLooper (NLPR) — dedicated looper FFGL plugin. A thin shell over the
  # shared effect runtime (SAME architecture as NanoBarrel): it dlopens the
  # sibling libbridge_server.dylib and drives ONE fixed effect
  # (control.nanolooper) through the shared executor, reading the effect WASM
  # from the colocated NanoBarrel bundle's Resources/wasm (ships none of its
  # own). Links NO engine — only the FFGL shell, the GL↔Metal InteropTexture
  # pair, the bridge loader, and a native Synth plucked by the shared runtime's
  # audio_bus fan-out. Live-only (nothing persisted).
  add_library(NanoLooper MODULE
    src/plugin/looper_plugin.mm
    src/plugin/nano_barrel/InteropTexture.m
    src/plugin/bridge_loader.cpp
    src/plugin/synth.mm
  )
  # The dylib is dlopen'd at runtime, not linked — but build it first so the
  # sibling copy (staged by NanoBarrelDeploy) exists for a from-scratch build.
  add_dependencies(NanoLooper bridge_server)
  target_include_directories(NanoLooper PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${CMAKE_SOURCE_DIR}/src/plugin/nano_barrel
  )
  target_link_libraries(NanoLooper PRIVATE
    nlohmann_json::nlohmann_json
    ffgl::sdk
    "-framework OpenGL"
    "-framework Metal"
    "-framework MetalKit"
    "-framework CoreVideo"
    "-framework AppKit"
    "-framework Foundation"
    "-framework AVFoundation"
    "-framework AudioToolbox"
  )
  target_compile_options(NanoLooper PRIVATE -Wno-attributes -Wno-deprecated-declarations)
  set_target_properties(NanoLooper PROPERTIES
    BUNDLE TRUE
    BUNDLE_EXTENSION "bundle"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_SOURCE_DIR}/src/plugin/Info.plist.in"
    LINK_FLAGS "${FFGL_BUNDLE_LINK_FLAGS}"
  )
  # Codesign so Resolume/Gatekeeper loads it (it dlopens the sibling
  # libbridge_server.dylib deployed by NanoBarrelDeploy). No wasm/dylib payload
  # of its own → a plain relink-time sign suffices, like NanoLooperCh.
  if(NOT DEFINED NANOBARREL_CODESIGN_IDENTITY)
    set(NANOBARREL_CODESIGN_IDENTITY "-")
  endif()
  add_custom_command(TARGET NanoLooper POST_BUILD
    COMMAND bash ${CMAKE_SOURCE_DIR}/tools/codesign_bundle.sh
            "${NANOBARREL_CODESIGN_IDENTITY}" $<TARGET_BUNDLE_DIR:NanoLooper>
    COMMENT "Codesigning NanoLooper.bundle (identity=${NANOBARREL_CODESIGN_IDENTITY})"
    VERBATIM)

  # NanoLooper Ch (NLCH) — scene-marker FFGL plugin. Dropped on a Resolume clip
  # to mark it launchable on a trigger channel; registers with the shared server
  # and persists {uuid, channel} inline in a nanoch://config? FILE param. Pure
  # passthrough marker (no WASM, no GL work). The shared dylib does the launching.
  add_library(NanoLooperCh MODULE
    src/plugin/channel_marker_plugin.cpp
    src/plugin/bridge_loader.cpp
  )
  target_include_directories(NanoLooperCh PRIVATE ${CMAKE_SOURCE_DIR}/src)
  target_link_libraries(NanoLooperCh PRIVATE
    ffgl::sdk
    "-framework OpenGL"
    miniz
    nlohmann_json::nlohmann_json
  )
  set_target_properties(NanoLooperCh PROPERTIES
    BUNDLE TRUE
    BUNDLE_EXTENSION "bundle"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_SOURCE_DIR}/src/plugin/Info.plist.in"
    LINK_FLAGS "${FFGL_BUNDLE_LINK_FLAGS}"
  )
  # Codesign so Resolume/Gatekeeper will load it (it dlopens the sibling
  # libbridge_server.dylib deployed by NanoBarrelDeploy). No wasm payload of its
  # own → a plain relink-time sign is sufficient.
  if(NOT DEFINED NANOBARREL_CODESIGN_IDENTITY)
    set(NANOBARREL_CODESIGN_IDENTITY "-")
  endif()
  add_custom_command(TARGET NanoLooperCh POST_BUILD
    COMMAND bash ${CMAKE_SOURCE_DIR}/tools/codesign_bundle.sh
            "${NANOBARREL_CODESIGN_IDENTITY}" $<TARGET_BUNDLE_DIR:NanoLooperCh>
    COMMENT "Codesigning NanoLooperCh.bundle (identity=${NANOBARREL_CODESIGN_IDENTITY})"
    VERBATIM)

  # NanoProbe — FFGL probe plugin: dynamic param registration + plugin-
  # set value experiment. Pure OpenGL passthrough + corner badge, no
  # WASM, no bridge. Output is the log at ~/Library/Logs/NanoProbe/.
  add_library(NanoProbe MODULE
    src/plugin/nano_probe/nano_probe_plugin.cpp
  )
  target_include_directories(NanoProbe PRIVATE ${CMAKE_SOURCE_DIR}/src)
  target_link_libraries(NanoProbe PRIVATE
    ffgl::sdk
    "-framework OpenGL"
  )
  set_target_properties(NanoProbe PROPERTIES
    BUNDLE TRUE
    BUNDLE_EXTENSION "bundle"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_SOURCE_DIR}/src/plugin/Info.plist.in"
    LINK_FLAGS "${FFGL_BUNDLE_LINK_FLAGS}"
  )

  # Codesign the bundle so Resolume / Gatekeeper accepts it. Override the
  # identity via
  #   cmake -DNANOPROBE_CODESIGN_IDENTITY="<Your Identity>" ..
  # Default `-` is ad-hoc; the helper script fails loudly if the named
  # identity isn't in the keychain.
  if(NOT DEFINED NANOPROBE_CODESIGN_IDENTITY)
    set(NANOPROBE_CODESIGN_IDENTITY "-")
  endif()
  add_custom_command(TARGET NanoProbe POST_BUILD
    COMMAND bash ${CMAKE_SOURCE_DIR}/tools/codesign_bundle.sh
            "${NANOPROBE_CODESIGN_IDENTITY}"
            $<TARGET_BUNDLE_DIR:NanoProbe>
    COMMENT "Codesigning NanoProbe.bundle (identity=${NANOPROBE_CODESIGN_IDENTITY})"
    VERBATIM
  )

  # NanoProbe2 — second FFGL probe focused on SetParamDisplayName /
  # SetParamVisibility live-update behavior and FF_TYPE_TEXT max
  # payload size round-trip. Same shape as NanoProbe (OpenGL only, no
  # WASM, no bridge). Cyan corner badge to distinguish in a comp.
  add_library(NanoProbe2 MODULE
    src/plugin/nano_probe2/nano_probe2_plugin.cpp
  )
  target_include_directories(NanoProbe2 PRIVATE ${CMAKE_SOURCE_DIR}/src)
  target_link_libraries(NanoProbe2 PRIVATE
    ffgl::sdk
    "-framework OpenGL"
  )
  set_target_properties(NanoProbe2 PROPERTIES
    BUNDLE TRUE
    BUNDLE_EXTENSION "bundle"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_SOURCE_DIR}/src/plugin/Info.plist.in"
    LINK_FLAGS "${FFGL_BUNDLE_LINK_FLAGS}"
  )
  if(NOT DEFINED NANOPROBE2_CODESIGN_IDENTITY)
    set(NANOPROBE2_CODESIGN_IDENTITY "-")
  endif()
  add_custom_command(TARGET NanoProbe2 POST_BUILD
    COMMAND bash ${CMAKE_SOURCE_DIR}/tools/codesign_bundle.sh
            "${NANOPROBE2_CODESIGN_IDENTITY}"
            $<TARGET_BUNDLE_DIR:NanoProbe2>
    COMMENT "Codesigning NanoProbe2.bundle (identity=${NANOPROBE2_CODESIGN_IDENTITY})"
    VERBATIM
  )

  # NanoProbe3 — third FFGL probe: tests whether FF_TYPE_FILE can carry
  # arbitrarily large opaque payloads (config blob) without the
  # Resolume UI degrading the way FF_TYPE_TEXT does. Orange corner
  # badge.
  add_library(NanoProbe3 MODULE
    src/plugin/nano_probe3/nano_probe3_plugin.cpp
  )
  target_include_directories(NanoProbe3 PRIVATE ${CMAKE_SOURCE_DIR}/src)
  target_link_libraries(NanoProbe3 PRIVATE
    ffgl::sdk
    "-framework OpenGL"
  )
  set_target_properties(NanoProbe3 PROPERTIES
    BUNDLE TRUE
    BUNDLE_EXTENSION "bundle"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_SOURCE_DIR}/src/plugin/Info.plist.in"
    LINK_FLAGS "${FFGL_BUNDLE_LINK_FLAGS}"
  )
  if(NOT DEFINED NANOPROBE3_CODESIGN_IDENTITY)
    set(NANOPROBE3_CODESIGN_IDENTITY "-")
  endif()
  add_custom_command(TARGET NanoProbe3 POST_BUILD
    COMMAND bash ${CMAKE_SOURCE_DIR}/tools/codesign_bundle.sh
            "${NANOPROBE3_CODESIGN_IDENTITY}"
            $<TARGET_BUNDLE_DIR:NanoProbe3>
    COMMENT "Codesigning NanoProbe3.bundle (identity=${NANOPROBE3_CODESIGN_IDENTITY})"
    VERBATIM
  )

  # NanoBarrel — v0 of the "barrel" plugin: one FFGL bundle that
  # hosts a sketch, persists its full state inside a FF_TYPE_FILE param
  # (proven safe up to 16 MB in probe 3), and stands up a per-instance
  # websocket bridge so the sketch editor can connect. Links bridge_core
  # directly — no WASM loader at this layer (the user wants
  # bridge_core's code reused statically; WASM reload isn't a v0 need).
  # NanoBarrel target is defined later, after the native host-services
  # block exposes effect_runtime / sketch_executor / gpu_backend.
endif()

# --- Bridge Harness (manual testing tool) ---
add_executable(gen_wasm tools/gen_wasm.cpp)

add_executable(bridge_harness tools/bridge_harness.cpp)
target_link_libraries(bridge_harness PRIVATE bridge_loader)
target_compile_definitions(bridge_harness PRIVATE
  BRIDGE_DYLIB_PATH="$<TARGET_FILE:bridge_server>"
)

# --- GL Harness (macOS visual test with WASM module) ---
if(APPLE AND EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/nanolooper.wasm")
  add_executable(looper_harness tools/harness/main.mm)
  target_include_directories(looper_harness PRIVATE ${CMAKE_SOURCE_DIR}/src)
  target_link_libraries(looper_harness PRIVATE
    bridge_loader
    canvas_renderer
    "-framework Cocoa"
    "-framework OpenGL"
    "-framework AVFoundation"
    "-framework AudioToolbox"
  )
  # Link synth
  target_sources(looper_harness PRIVATE src/plugin/synth.mm)
  target_compile_definitions(looper_harness PRIVATE
    BRIDGE_DYLIB_PATH="$<TARGET_FILE:bridge_server>"
    NANOLOOPER_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/nanolooper.wasm"
  )
endif()

# ============================================================================
# Native host services for the WASM effect/executor runtime
# ============================================================================
#
# Effects are WASM-only: each compiles to a `.wasm` bundle (wasm_modules/*/
# build.sh) loaded at runtime — never statically linked into a native binary.
# This block builds the HOST side those bundles run against: the text engine
# (FreeType + msdfgen), the `effect_runtime` (host-import C symbols + GPU/SPV→MSL
# services), `sketch_augment`/`sketch_executor`, and the native test/bench tools.
# `EFFECTS_NATIVE_INC` is just the effect ABI header dir (host.h/gpu.h/...), used
# by effect_runtime + the bench/test tools that include those headers.

if(APPLE)
  set(EFFECTS_NATIVE_INC "${CMAKE_SOURCE_DIR}/wasm_modules/include")

  # ==========================================================================
  # Shared text engine (FreeType + msdfgen + libunibreak) — the pure-CPU
  # engine behind the text.* host service. Compiled here as a static lib (the
  # SAME source also builds to text_engine.wasm for the web host). The vendored
  # snapshots live under third_party/; fetch them at configure time if absent.
  # ==========================================================================
  set(TEXT_TP "${CMAKE_SOURCE_DIR}/third_party")
  if(NOT EXISTS "${TEXT_TP}/freetype")
    message(STATUS "text_engine: fetching vendored deps (FreeType/msdfgen/...)")
    execute_process(COMMAND bash "${TEXT_TP}/fetch_deps.sh"
                    WORKING_DIRECTORY "${TEXT_TP}")
  endif()

  set(FT_SRCS base/ftbase base/ftinit base/ftsystem base/ftdebug base/ftbitmap
      base/ftmm sfnt/sfnt truetype/truetype psnames/psnames cff/cff psaux/psaux
      pshinter/pshinter)
  set(MSDF_SRCS Contour DistanceMapping EdgeHolder MSDFErrorCorrection Projection
      Scanline Shape contour-combiners edge-coloring edge-segments edge-selectors
      equation-solver msdf-error-correction msdfgen rasterization render-sdf
      sdf-error-estimation shape-description)
  set(UB_SRCS linebreak linebreakdata linebreakdef unibreakbase unibreakdef
      eastasianwidthdef eastasianwidthdata)
  set(TEXT_ENGINE_SRCS src/text/text_engine.cpp)
  foreach(s ${FT_SRCS})
    list(APPEND TEXT_ENGINE_SRCS "${TEXT_TP}/freetype/src/${s}.c")
  endforeach()
  foreach(c ${MSDF_SRCS})
    list(APPEND TEXT_ENGINE_SRCS "${TEXT_TP}/msdfgen/core/${c}.cpp")
  endforeach()
  foreach(s ${UB_SRCS})
    list(APPEND TEXT_ENGINE_SRCS "${TEXT_TP}/libunibreak/src/${s}.c")
  endforeach()

  add_library(text_engine STATIC ${TEXT_ENGINE_SRCS})
  target_include_directories(text_engine PUBLIC ${CMAKE_SOURCE_DIR}/src/text)
  target_include_directories(text_engine PRIVATE
    "${TEXT_TP}/freetype/include" "${TEXT_TP}/ft-config"
    "${TEXT_TP}/msdf-config" "${TEXT_TP}/msdfgen" "${TEXT_TP}/libunibreak/src")
  target_compile_definitions(text_engine PRIVATE
    FT2_BUILD_LIBRARY
    FT_CONFIG_OPTIONS_H="ftoption_custom.h"
    FT_CONFIG_MODULES_H="ftmodule_custom.h")
  # The engine is exception/RTTI-free (matches the wasm build), keeping it
  # deterministic and byte-parity with text_engine.wasm.
  target_compile_options(text_engine PRIVATE -fno-exceptions -fno-rtti -O2)

  # ==========================================================================
  # text_blitz — the Rust HTML/CSS layout lib (Stylo + Taffy + parley), built
  # to a native staticlib by cargo and imported. Drives the source.text.rich mode.
  # ==========================================================================
  set(TEXT_BLITZ_DIR "${CMAKE_SOURCE_DIR}/text_blitz")
  set(TEXT_BLITZ_LIB "${TEXT_BLITZ_DIR}/target/release/libtext_blitz.a")
  add_custom_command(
    OUTPUT "${TEXT_BLITZ_LIB}"
    COMMAND cargo build --release
    WORKING_DIRECTORY "${TEXT_BLITZ_DIR}"
    COMMENT "Building libtext_blitz.a (Rust: Stylo + Taffy + parley)"
    VERBATIM)
  add_custom_target(text_blitz_build DEPENDS "${TEXT_BLITZ_LIB}")
  add_library(text_blitz STATIC IMPORTED GLOBAL)
  set_target_properties(text_blitz PROPERTIES IMPORTED_LOCATION "${TEXT_BLITZ_LIB}")

  # The in-process runtime: implements every host-import C symbol the WASM
  # effects + executor reference (host/gpu/text/val/io services). Statically
  # linked into the test runner CLI, the bench tools, and the NanoBarrel plugin.
  add_library(effect_runtime STATIC
    src/runtime/effect_runtime.cpp
    src/runtime/host_impls.cpp
    src/runtime/host_impls_text.cpp
    src/runtime/host_impls_font.mm
    src/runtime/gpu_impls.cpp
    src/runtime/fusion_codegen.cpp
  )
  add_dependencies(effect_runtime text_blitz_build)
  target_include_directories(effect_runtime PUBLIC
    ${CMAKE_SOURCE_DIR}/src
    ${EFFECTS_NATIVE_INC}
  )
  target_link_libraries(effect_runtime PUBLIC
    gpu_backend
    text_engine
    text_blitz
    wasm_host
    spv_to_msl
    nlohmann_json::nlohmann_json
    # Core Text font provider (host_impls_font.mm).
    "-framework CoreText"
    # Rust staticlib pulls these macOS system frameworks/libs.
    "-framework CoreFoundation" "-framework Security"
    "-framework SystemConfiguration" "-liconv" "-lobjc"
  )
  # Suppress noise about ignored WASM-only __attribute__((import_module))
  # annotations on the effect host-import declarations.
  target_compile_options(effect_runtime PRIVATE -Wno-attributes)

  # --- Shared sketch-render preparation ---
  # Lives outside the effect runtime so any host (FFGL plugin, future
  # CLI, wasm-bound web engine-worker) consumes the same augmentation
  # logic for implicit struct-rail wiring.
  add_library(sketch_augment STATIC
    src/sketch/sketch_augment.cpp
  )
  target_include_directories(sketch_augment PUBLIC ${CMAKE_SOURCE_DIR}/src)
  target_link_libraries(sketch_augment PUBLIC nlohmann_json::nlohmann_json)

  # --- Shared sketch executor ---
  # Walks an augmented sketch graph, dispatching effects through the
  # EffectRuntime. Reusable by the FFGL barrel plugin and the future
  # bridge_server-with-native-effects path. Host owns the runtime +
  # GPUBackend + input/output texture handles; this library handles
  # tap routing, intermediate pool management, and the augmentation
  # step internally.
  add_library(sketch_executor STATIC
    src/sketch/module_registry.cpp
    src/sketch/sketch_executor.cpp
    src/sketch/sidechannel_bus.cpp
    src/sketch/trigger_bus.cpp
    src/sketch/effrt_impls.cpp
    src/sketch/executor_host.cpp
    src/sketch/wasm_executor_driver.cpp
    src/sketch/wasm_bundles.cpp
    src/sketch/text_host_wasm.cpp
    src/sketch/comp/comp_executor.cpp
    src/sketch/comp/comp_api.cpp
  )
  target_include_directories(sketch_executor PUBLIC ${CMAKE_SOURCE_DIR}/src)
  target_link_libraries(sketch_executor PUBLIC
    sketch_augment
    effect_runtime
    gpu_backend
    wasm_host
    nlohmann_json::nlohmann_json
  )
  # When AOT loading is built in, the bundle loader prefers a per-arch `.aot`
  # sidecar over the `.wasm` (graceful fallback if absent).
  if(NANO_WASM_AOT)
    target_compile_definitions(sketch_executor PRIVATE NANO_WASM_AOT_ENABLED=1)
  endif()

  # --- Shared render engine inside the dylib ---
  # The whole effect runtime lives in libbridge_server.dylib as a process
  # singleton (BarrelRuntime), so every NanoBarrel instance shares ONE Metal
  # backend + WAMR runtime + loaded effect set. Because the runtime relies on
  # process-global state (g_runtime, the effrt frame table, g_host_*), only ONE
  # image may link it — the dylib here; the barrel bundle must NOT (see its
  # link list). sketch_executor PUBLIC-pulls effect_runtime/gpu_backend/
  # wasm_host/text_engine/spv_to_msl transitively.
  target_sources(bridge_server PRIVATE
    src/bridge/barrel_runtime.mm
    src/midi/midi_host.mm)
  target_link_libraries(bridge_server PRIVATE sketch_executor "-framework CoreMIDI")
  set_source_files_properties(src/bridge/barrel_runtime.mm src/midi/midi_host.mm
    PROPERTIES COMPILE_FLAGS "-fobjc-arc")

  # Headless MidiHost goldens (library/alias/sim table logic; never start()s
  # CoreMIDI). Compiles midi_host.mm directly — it lives in bridge_server,
  # which a test can't link (process-global executor state).
  if(TARGET Catch2::Catch2WithMain)
    add_executable(test_midi_host tests/test_midi_host.cpp src/midi/midi_host.mm)
    target_include_directories(test_midi_host PRIVATE ${CMAKE_SOURCE_DIR}/src)
    target_link_libraries(test_midi_host PRIVATE
      nlohmann_json::nlohmann_json Catch2::Catch2WithMain
      "-framework CoreMIDI" "-framework CoreFoundation" "-framework Foundation")
    set_source_files_properties(src/midi/midi_host.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
    catch_discover_tests(test_midi_host)
  endif()

  # Config-driven CLI test runner — JSON config on stdin, JSON pixel
  # result on stdout. Mirrors web/public/gpu-test-runner.html for the
  # dual-backend tests.
  add_executable(native_test_runner tools/native_test_runner.mm)
  target_include_directories(native_test_runner PRIVATE
    ${CMAKE_SOURCE_DIR}/src
  )
  target_link_libraries(native_test_runner PRIVATE
    sketch_executor   # ModuleRegistry + WasmEffectBundles (loads core/lights/nano.wasm)
    effect_runtime
    gpu_backend
    nlohmann_json::nlohmann_json
    "-framework Metal"
    "-framework Foundation"
  )
  target_compile_options(native_test_runner PRIVATE -Wno-attributes)
  # Effects load from their WASM bundles, never statically linked.
  target_compile_definitions(native_test_runner PRIVATE
    NANO_WASM_DIR="${CMAKE_SOURCE_DIR}/../build/wasm")

  # Structured published-state store + numeric readers (publishedScalar /
  # readTriggers): the per-frame paths that replaced the JSON round-trips.
  add_executable(test_published_state tests/test_published_state.cpp)
  target_link_libraries(test_published_state PRIVATE
    effect_runtime Catch2::Catch2WithMain)
  target_compile_options(test_published_state PRIVATE -Wno-attributes)
  catch_discover_tests(test_published_state)

  # WASM effect driver (barrel-loads-WASM): drive a WASM-backed EffectDesc
  # through the EffectInstance/EffectRuntime path. Uses mod.source.lfo (no GPU).
  if(EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/testonly.wasm")
    add_executable(test_effect_driver tests/test_effect_driver.cpp)
    target_link_libraries(test_effect_driver PRIVATE
      effect_runtime sketch_executor wasm_host Catch2::Catch2WithMain)
    target_compile_definitions(test_effect_driver PRIVATE
      TESTONLY_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/testonly.wasm")
    target_compile_options(test_effect_driver PRIVATE -Wno-attributes)
    catch_discover_tests(test_effect_driver)
  endif()

  # Bundle loader (barrel cutover). No Metal needed — schema publishes even
  # when an effect's module_init skips shader compile on a null backend.
  if(EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/core.wasm")
    add_executable(test_wasm_bundles tests/test_wasm_bundles.cpp)
    target_link_libraries(test_wasm_bundles PRIVATE
      sketch_executor wasm_host Catch2::Catch2WithMain)
    target_compile_definitions(test_wasm_bundles PRIVATE
      CORE_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/core.wasm")
    target_compile_options(test_wasm_bundles PRIVATE -Wno-attributes)
    catch_discover_tests(test_wasm_bundles)
  endif()

  # Native OS-font resolution for the text.* service (Core Text provider +
  # the text_layout spec scan). CPU-only — no GPU backend, no wasm bundles.
  add_executable(test_text_fonts tests/test_text_fonts.cpp)
  target_link_libraries(test_text_fonts PRIVATE
    effect_runtime Catch2::Catch2WithMain)
  target_compile_options(test_text_fonts PRIVATE -Wno-attributes)
  catch_discover_tests(test_text_fonts)

  # End-to-end GPU render of a WASM effect on a real Metal backend.
  if(EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/core.wasm")
    # Composition executor end-to-end GPU render (Metal-gated): pixel parity
    # vs a plain executor, param-op plan reuse, automation drive, live
    # published-output fold.
    add_executable(test_comp_render tests/test_comp_render.cpp)
    target_link_libraries(test_comp_render PRIVATE
      effect_runtime sketch_executor wasm_host gpu_backend
      Catch2::Catch2WithMain
      "-framework Metal" "-framework Foundation")
    target_compile_definitions(test_comp_render PRIVATE
      CORE_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/core.wasm")
    catch_discover_tests(test_comp_render)

    add_executable(test_effect_render tests/test_effect_render.cpp)
    target_link_libraries(test_effect_render PRIVATE
      effect_runtime sketch_executor wasm_host gpu_backend
      Catch2::Catch2WithMain
      "-framework Metal" "-framework Foundation")
    target_compile_definitions(test_effect_render PRIVATE
      CORE_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/core.wasm"
      TESTONLY_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/testonly.wasm"
      NANO_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/nano.wasm"
      LEGACY_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/legacy.wasm")
    # text.wasm bridge (step #4): source.text.plain resolves text.* to the native
    # TextEngine. Only define the path when the bundle exists so the test's
    # text case compiles in conditionally.
    if(EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/text.wasm")
      target_compile_definitions(test_effect_render PRIVATE
        TEXT_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/text.wasm")
    endif()
    target_compile_options(test_effect_render PRIVATE -Wno-attributes)
    catch_discover_tests(test_effect_render)

    # TEMPORARY repro: dashboard/barrel_macros wire -> R/B swap.
    add_executable(test_texture_copy_format tests/test_texture_copy_format.cpp)
    target_link_libraries(test_texture_copy_format PRIVATE
      effect_runtime sketch_executor wasm_host gpu_backend
      Catch2::Catch2WithMain
      "-framework Metal" "-framework Foundation")
    target_compile_definitions(test_texture_copy_format PRIVATE
      CORE_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/core.wasm")
    target_compile_options(test_texture_copy_format PRIVATE -Wno-attributes)
    catch_discover_tests(test_texture_copy_format)

    # External scalar rails (MIDI device wires) through the executor.
    add_executable(test_external_scalars tests/test_external_scalars.cpp)
    target_link_libraries(test_external_scalars PRIVATE
      effect_runtime sketch_executor wasm_host gpu_backend
      Catch2::Catch2WithMain
      "-framework Metal" "-framework Foundation")
    target_compile_definitions(test_external_scalars PRIVATE
      CORE_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/core.wasm")
    target_compile_options(test_external_scalars PRIVATE -Wno-attributes)
    catch_discover_tests(test_external_scalars)

    # Clean-frame exec-doc cache goldens (wire liveness, injected scalars,
    # enable toggles, structural rebuilds).
    add_executable(test_exec_doc_cache tests/test_exec_doc_cache.cpp)
    target_link_libraries(test_exec_doc_cache PRIVATE
      effect_runtime sketch_executor wasm_host gpu_backend
      Catch2::Catch2WithMain
      "-framework Metal" "-framework Foundation")
    target_compile_definitions(test_exec_doc_cache PRIVATE
      CORE_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/core.wasm")
    target_compile_options(test_exec_doc_cache PRIVATE -Wno-attributes)
    catch_discover_tests(test_exec_doc_cache)
  endif()

  # End-to-end GPU render of warp.plane_shear (nano.wasm) on a real Metal backend.
  if(EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/nano.wasm")
    add_executable(test_plane_shear tests/test_plane_shear.cpp)
    target_link_libraries(test_plane_shear PRIVATE
      effect_runtime sketch_executor wasm_host gpu_backend
      Catch2::Catch2WithMain
      "-framework Metal" "-framework Foundation")
    target_compile_definitions(test_plane_shear PRIVATE
      NANO_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/nano.wasm")
    target_compile_options(test_plane_shear PRIVATE -Wno-attributes)
    catch_discover_tests(test_plane_shear)
  endif()

  # End-to-end GPU render of warp.tri_shear (nano.wasm) on a real Metal backend.
  if(EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/nano.wasm")
    add_executable(test_tri_shear tests/test_tri_shear.cpp)
    target_link_libraries(test_tri_shear PRIVATE
      effect_runtime sketch_executor wasm_host gpu_backend
      Catch2::Catch2WithMain
      "-framework Metal" "-framework Foundation")
    target_compile_definitions(test_tri_shear PRIVATE
      NANO_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/nano.wasm")
    target_compile_options(test_tri_shear PRIVATE -Wno-attributes)
    catch_discover_tests(test_tri_shear)
  endif()

  # End-to-end GPU render of warp.envelope (nano.wasm) on a real Metal backend.
  if(EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/nano.wasm")
    add_executable(test_envelope_warp tests/test_envelope_warp.cpp)
    target_link_libraries(test_envelope_warp PRIVATE
      effect_runtime sketch_executor wasm_host gpu_backend
      Catch2::Catch2WithMain
      "-framework Metal" "-framework Foundation")
    target_compile_definitions(test_envelope_warp PRIVATE
      NANO_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/nano.wasm")
    target_compile_options(test_envelope_warp PRIVATE -Wno-attributes)
    catch_discover_tests(test_envelope_warp)
  endif()

  # Shared-runtime instance isolation: two namespaced executors on one runtime.
  if(EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/core.wasm")
    add_executable(test_barrel_isolation tests/test_barrel_isolation.cpp)
    target_link_libraries(test_barrel_isolation PRIVATE
      effect_runtime sketch_executor wasm_host gpu_backend
      Catch2::Catch2WithMain
      "-framework Metal" "-framework Foundation")
    target_compile_definitions(test_barrel_isolation PRIVATE
      CORE_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/core.wasm")
    target_compile_options(test_barrel_isolation PRIVATE -Wno-attributes)
    catch_discover_tests(test_barrel_isolation)
  endif()

  # Per-sketch output format: internal resolution/bit-depth override through
  # the shared executor (identity guard, scaled intermediates, 16F precision).
  if(EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/core.wasm")
    add_executable(test_sketch_output_format tests/test_sketch_output_format.cpp)
    target_link_libraries(test_sketch_output_format PRIVATE
      effect_runtime sketch_executor wasm_host gpu_backend
      Catch2::Catch2WithMain
      "-framework Metal" "-framework Foundation")
    target_compile_definitions(test_sketch_output_format PRIVATE
      CORE_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/core.wasm")
    target_compile_options(test_sketch_output_format PRIVATE -Wno-attributes)
    catch_discover_tests(test_sketch_output_format)
  endif()

  # B3 end-to-end: drive executor.wasm through WAMR vs the native executor.
  if(EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/core.wasm"
     AND EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/executor.wasm")
    add_executable(test_executor_wasm tests/test_executor_wasm.cpp)
    target_link_libraries(test_executor_wasm PRIVATE
      effect_runtime sketch_executor wasm_host gpu_backend
      Catch2::Catch2WithMain
      "-framework Metal" "-framework Foundation")
    target_compile_definitions(test_executor_wasm PRIVATE
      CORE_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/core.wasm"
      EXECUTOR_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/executor.wasm")
    target_compile_options(test_executor_wasm PRIVATE -Wno-attributes)
    catch_discover_tests(test_executor_wasm)
  endif()

  # --- ffgl_runner: standalone host that dlopens an FFGL bundle ---
  # Headless FFGL host for iterating on NanoBarrel without Resolume — feed
  # it a bundle path, get back stderr logs + an output PNG. Borrows the
  # GL↔Metal InteropTexture from the nano_barrel plugin source.
  add_executable(ffgl_runner
    tools/ffgl_runner.mm
    src/plugin/nano_barrel/InteropTexture.m
  )
  target_include_directories(ffgl_runner PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${CMAKE_SOURCE_DIR}/src/plugin/nano_barrel
  )
  target_link_libraries(ffgl_runner PRIVATE
    ffgl::sdk
    miniz
    nlohmann_json::nlohmann_json
    "-framework OpenGL"
    "-framework Metal"
    "-framework MetalKit"
    "-framework CoreVideo"
    "-framework AppKit"
    "-framework Foundation"
    z
  )
  target_compile_options(ffgl_runner PRIVATE -Wno-attributes -Wno-deprecated-declarations)

  # --- preview_bench: simulated-editor benchmark for the barrel preview path ---
  # Drives bridge_executor_render (the exact FFGL entry: rail publish, capture
  # hooks, fusion barriers, preview readback+broadcast) while an in-process
  # ixwebsocket client plays the editor (observe + preview_requests + drain).
  # Binds the WS server on NANO_BRIDGE_PORT so it never collides with a live
  # Arena. See tools/preview_bench.mm for the scenario matrix.
  add_executable(preview_bench tools/preview_bench.mm)
  target_include_directories(preview_bench PRIVATE ${CMAKE_SOURCE_DIR}/src)
  target_link_libraries(preview_bench PRIVATE
    bridge_server
    ixwebsocket
    nlohmann_json::nlohmann_json
    "-framework Metal"
    "-framework Foundation"
  )
  target_compile_options(preview_bench PRIVATE -fobjc-arc)

  # --- NanoBarrel FFGL bundle ---
  # The full-fat barrel: one FFGL bundle that hosts a sketch AND executes it
  # each frame via the Metal-backed effect runtime. The editor bridge is NOT
  # per-instance — the barrel is a CLIENT of the shared libbridge_server.dylib
  # singleton (located via dladdr next to the bundle, dlopen'd through
  # BridgeLoader at InitGL), so it links NONE of the bridge statics itself
  # (the singleton must live only in the dylib). The FF_TYPE_FILE config is
  # still persisted by Resolume. NO static effects: every effect (text
  # included) loads as a WASM bundle from Resources/wasm/ via sketch_executor's
  # WasmEffectBundles. InteropTexture supplies the GL↔Metal bridge.
  set(FFGL_BUNDLE_LINK_FLAGS_BARREL "-undefined dynamic_lookup")
  add_library(NanoBarrel MODULE
    src/plugin/nano_barrel/nano_barrel_plugin.mm
    src/plugin/nano_barrel/InteropTexture.m
    src/plugin/bridge_loader.cpp
  )
  # The shared dylib is dlopen'd at runtime, not linked — but it must be built
  # before NanoBarrel's POST_BUILD copies it next to the bundle.
  add_dependencies(NanoBarrel bridge_server)
  target_include_directories(NanoBarrel PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${CMAKE_SOURCE_DIR}/src/plugin/nano_barrel
  )
  # Thin client: NO engine. The whole effect runtime (sketch_executor +
  # effect_runtime + gpu_backend + wasm_host + text_engine) lives in
  # libbridge_server.dylib as a process singleton (BarrelRuntime), dlopen'd at
  # runtime via BridgeLoader. The barrel links only the FFGL shell, the bridge
  # loader (compiled in this target), nlohmann_json (header-only), and the
  # Metal/GL frameworks its InteropTexture pair needs.
  target_link_libraries(NanoBarrel PRIVATE
    miniz
    nlohmann_json::nlohmann_json
    ffgl::sdk
    "-framework OpenGL"
    "-framework Metal"
    "-framework MetalKit"
    "-framework CoreVideo"
    "-framework AppKit"
    "-framework Foundation"
  )
  target_compile_options(NanoBarrel PRIVATE -Wno-attributes -Wno-deprecated-declarations)
  set_target_properties(NanoBarrel PROPERTIES
    BUNDLE TRUE
    BUNDLE_EXTENSION "bundle"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_SOURCE_DIR}/src/plugin/Info.plist.in"
    LINK_FLAGS "${FFGL_BUNDLE_LINK_FLAGS_BARREL}"
  )
  if(NOT DEFINED NANOBARREL_CODESIGN_IDENTITY)
    set(NANOBARREL_CODESIGN_IDENTITY "-")
  endif()
  # --- Keep NanoBarrel.bundle's payload fresh INDEPENDENTLY of relinking it ---
  # The barrel loads its effect WASM from Contents/Resources/wasm/ (a COPY) and
  # dlopens the SIBLING libbridge_server.dylib. Both inputs are built OUTSIDE
  # this target — the .wasm/.aot by wasm_modules/build_all.sh + build_aot.sh, the
  # dylib by the bridge_server target — so a plain POST_BUILD (which fires ONLY
  # when NanoBarrel itself relinks) leaves a STALE bundle whenever you rebuild
  # just the wasm or just the dylib. Instead we drive the whole deploy from a
  # STAMP that DEPENDS on every input, wrapped in an `ALL` custom target: a bare
  # `cmake --build build` re-copies + re-signs whatever is newer, with no
  # NanoBarrel relink required.
  #
  # ORDER MATTERS: every step that writes into the bundle must run BEFORE the
  # final codesign, which re-seals the modified Resources. An ad-hoc signature
  # goes invalid the instant a sealed file changes, and Resolume/Gatekeeper then
  # refuse the load — so the stamp appends copy steps in call order and
  # codesigns (dylib, then bundle) LAST.
  set(_nb_stamp "${CMAKE_CURRENT_BINARY_DIR}/nanobarrel_deploy.stamp")
  set(_nb_bundle "$<TARGET_BUNDLE_DIR:NanoBarrel>")

  # Base step: ensure the wasm dir exists. DEPENDS the NanoBarrel bundle + the
  # dylib so the stamp re-runs whenever either is rebuilt.
  add_custom_command(OUTPUT "${_nb_stamp}"
    COMMAND ${CMAKE_COMMAND} -E make_directory "${_nb_bundle}/Contents/Resources/wasm"
    DEPENDS NanoBarrel "$<TARGET_FILE:bridge_server>"
    COMMENT "Deploying NanoBarrel.bundle payload (wasm + dylib) + resigning"
    VERBATIM)

  # Latin primary font (default.ttf) for the text.* service — parity-exact
  # primary; CJK falls back to system faces via Core Text. Best-effort: the file
  # is gitignored, so skip quietly if absent. Folded into the stamp so a font
  # swap also re-seals the bundle.
  set(NANOBARREL_FONT_SRC "${CMAKE_SOURCE_DIR}/../web/public/fonts/default.ttf")
  if(EXISTS "${NANOBARREL_FONT_SRC}")
    add_custom_command(OUTPUT "${_nb_stamp}" APPEND
      COMMAND ${CMAKE_COMMAND} -E make_directory "${_nb_bundle}/Contents/Resources/fonts"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
              "${NANOBARREL_FONT_SRC}" "${_nb_bundle}/Contents/Resources/fonts/default.ttf"
      DEPENDS "${NANOBARREL_FONT_SRC}")
  else()
    message(STATUS "NanoBarrel: default.ttf not found — text effects will use the system UI font as primary")
  endif()

  # Effect .wasm bundles (+ optional per-arch `<bundle>-<arch>.aot` sidecars the
  # loader prefers; the portable `.wasm` is the fallback). Guarded by EXISTS at
  # CONFIGURE time — the files are produced by external shell scripts, so they
  # can only be a CMake DEPENDS when already present; reconfigure after a fresh
  # bundle first appears. (executor.wasm is NOT bundled — the barrel runs the
  # executor natively; executor.wasm is a web-only artifact.)
  foreach(_b core lights nano text richtext legacy)
    set(_wsrc "${CMAKE_SOURCE_DIR}/../build/wasm/${_b}.wasm")
    if(EXISTS "${_wsrc}")
      add_custom_command(OUTPUT "${_nb_stamp}" APPEND
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${_wsrc}" "${_nb_bundle}/Contents/Resources/wasm/${_b}.wasm"
        DEPENDS "${_wsrc}")
    endif()
    foreach(_arch aarch64 x86_64)
      set(_aot "${CMAKE_SOURCE_DIR}/../build/wasm/${_b}-${_arch}.aot")
      if(EXISTS "${_aot}")
        add_custom_command(OUTPUT "${_nb_stamp}" APPEND
          COMMAND ${CMAKE_COMMAND} -E copy_if_different
                  "${_aot}" "${_nb_bundle}/Contents/Resources/wasm/${_b}-${_arch}.aot"
          DEPENDS "${_aot}")
      endif()
    endforeach()
  endforeach()

  # Deploy + sign the shared dylib as a SIBLING of the bundle. dlopen shares one
  # image only for the same path, so a single sibling copy backs every NanoBarrel
  # (and the looper marker) with ONE shared singleton — a private per-bundle copy
  # would spin up a second WsServer on :8081 and fail. Then re-seal the bundle
  # LAST (after all Resources writes above) and touch the stamp.
  add_custom_command(OUTPUT "${_nb_stamp}" APPEND
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "$<TARGET_FILE:bridge_server>" "${_nb_bundle}/../libbridge_server.dylib"
    COMMAND codesign --force --sign "${NANOBARREL_CODESIGN_IDENTITY}"
            "${_nb_bundle}/../libbridge_server.dylib"
    COMMAND bash ${CMAKE_SOURCE_DIR}/tools/codesign_bundle.sh
            "${NANOBARREL_CODESIGN_IDENTITY}" "${_nb_bundle}"
    COMMAND ${CMAKE_COMMAND} -E touch "${_nb_stamp}")

  # ALL target → a bare `cmake --build build` always runs the deploy; the stamp's
  # DEPENDS make it a no-op when nothing changed.
  add_custom_target(NanoBarrelDeploy ALL DEPENDS "${_nb_stamp}")

  # --- benchmark_barrel CLI ---
  # Standalone driver that exercises the same render path as
  # NanoBarrel::ProcessOpenGL (GL→Metal blit → executor → submit →
  # Metal→GL blit) but without the FFGL SDK or the bridge, so we can
  # micro-benchmark optimizations in isolation.
  add_executable(benchmark_barrel
    tests/benchmark_barrel.mm
    src/plugin/nano_barrel/InteropTexture.m
  )
  target_include_directories(benchmark_barrel PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${EFFECTS_NATIVE_INC}
    ${CMAKE_SOURCE_DIR}/src/plugin/nano_barrel
  )
  target_link_libraries(benchmark_barrel PRIVATE
    sketch_executor
    nlohmann_json::nlohmann_json
    "-framework OpenGL"
    "-framework Metal"
    "-framework CoreVideo"
    "-framework AppKit"
    "-framework Foundation"
  )
  target_compile_options(benchmark_barrel PRIVATE -Wno-deprecated-declarations)
  # Effects load from core.wasm (no static effect linking); EXECUTOR_WASM_DIR
  # holds executor.aot / executor.wasm for the `--wasm` (wasm-executor) mode.
  target_compile_definitions(benchmark_barrel PRIVATE
    CORE_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/core.wasm"
    EXECUTOR_WASM_DIR="${CMAKE_SOURCE_DIR}/../build/wasm")
endif()
