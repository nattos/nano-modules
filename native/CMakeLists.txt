cmake_minimum_required(VERSION 3.16)
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

# Configure WAMR: interpreter only, no AOT/JIT
set(WAMR_ROOT_DIR ${wamr_SOURCE_DIR})
set(WAMR_BUILD_INTERP 1)
set(WAMR_BUILD_FAST_INTERP 1)
set(WAMR_BUILD_AOT 0)
set(WAMR_BUILD_JIT 0)
set(WAMR_BUILD_FAST_JIT 0)
set(WAMR_BUILD_LIBC_BUILTIN 1)
set(WAMR_BUILD_LIBC_WASI 1)
set(WAMR_BUILD_SIMD 0)
set(WAMR_BUILD_REF_TYPES 0)
set(WAMR_BUILD_BULK_MEMORY 1)
set(WAMR_BUILD_PLATFORM "darwin")

include(${WAMR_ROOT_DIR}/build-scripts/runtime_lib.cmake)
add_library(vmlib STATIC ${WAMR_RUNTIME_LIB_SOURCE})
target_include_directories(vmlib PUBLIC ${WAMR_ROOT_DIR}/core/iwasm/include)
target_link_libraries(vmlib PUBLIC -lm -ldl ${CMAKE_THREAD_LIBS_INIT})

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

# --- Bridge Server shared library (dylib) ---
add_library(bridge_server SHARED
  src/bridge/bridge_server.cpp
  src/bridge/bridge_api.cpp
  src/bridge/composition_cache.cpp
)
target_include_directories(bridge_server PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(bridge_server PRIVATE
  bridge_core
  resolume_client
  bridge_ws_server
  wasm_host
  nlohmann_json::nlohmann_json
)

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
target_link_libraries(test_composition_cache PRIVATE nlohmann_json::nlohmann_json Catch2::Catch2WithMain)
catch_discover_tests(test_composition_cache)

add_executable(test_canvas_host tests/test_canvas_host.cpp)
target_link_libraries(test_canvas_host PRIVATE wasm_host Catch2::Catch2WithMain)
catch_discover_tests(test_canvas_host)

# NanoLooper WASM module integration test (requires nanolooper.wasm to be built)
if(EXISTS "${CMAKE_SOURCE_DIR}/../build/wasm/nanolooper.wasm")
  add_executable(test_nanolooper_wasm tests/test_nanolooper_wasm.cpp)
  target_link_libraries(test_nanolooper_wasm PRIVATE wasm_host Catch2::Catch2WithMain)
  target_compile_definitions(test_nanolooper_wasm PRIVATE
    NANOLOOPER_WASM_PATH="${CMAKE_SOURCE_DIR}/../build/wasm/nanolooper.wasm"
  )
  catch_discover_tests(test_nanolooper_wasm)
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

  # NanoLooper FFGL plugin bundle (WASM-based looper)
  add_library(NanoLooper MODULE
    src/plugin/looper_plugin.cpp
    src/plugin/bridge_loader.cpp
    src/plugin/synth.mm
    src/canvas/canvas_renderer.cpp
    src/canvas/image_loader.mm
  )
  target_include_directories(NanoLooper PRIVATE ${CMAKE_SOURCE_DIR}/src)
  target_link_libraries(NanoLooper PRIVATE
    ffgl::sdk
    "-framework OpenGL"
    "-framework CoreGraphics"
    "-framework Foundation"
    "-framework AVFoundation"
    "-framework AudioToolbox"
  )
  set_target_properties(NanoLooper PROPERTIES
    BUNDLE TRUE
    BUNDLE_EXTENSION "bundle"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_SOURCE_DIR}/src/plugin/Info.plist.in"
    LINK_FLAGS "${FFGL_BUNDLE_LINK_FLAGS}"
  )

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

  # Codesign the bundle so Resolume / Gatekeeper accepts it. Same shape
  # as StreakyBlobs (see further below); override the identity via
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
  # NanoBarrel target is defined later, after the no-WASM native
  # runtime block exposes effects_native / effect_runtime / gpu_backend.
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
# No-WASM native effect runtime + dual-backend test runner (Phase 1)
# ============================================================================
#
# Effects compile twice: as WASM (via wasm_modules/*/build.sh) for the
# web runtime, AND as native C++ objects linked against the in-process
# `effect_runtime` library for the no-WASM Metal path. This unblocks
# both the dual-backend test runner (compare Puppeteer/WebGPU vs native
# Metal pixel-for-pixel) and the StreakyBlobs FFGL plugin in Phase 3.
#
# Build depends on the WASM build having produced .spv files under
# native/build/tmp/ — they're consumed by `naga` to emit per-effect MSL
# headers via build_msl_headers.sh.

if(APPLE)
  set(EFFECTS_NATIVE_TMP "${CMAKE_SOURCE_DIR}/build/tmp")
  set(EFFECTS_NATIVE_INC "${CMAKE_SOURCE_DIR}/wasm_modules/include")

  # The in-process runtime: implements every host-import C symbol the
  # effects reference. Statically linked into both the test runner CLI
  # and (Phase 3) the StreakyBlobs FFGL bundle.
  add_library(effect_runtime STATIC
    src/runtime/effect_runtime.cpp
    src/runtime/host_impls.cpp
    src/runtime/gpu_impls.cpp
    src/runtime/fusion_codegen.cpp
  )
  target_include_directories(effect_runtime PUBLIC
    ${CMAKE_SOURCE_DIR}/src
    ${EFFECTS_NATIVE_INC}
    ${EFFECTS_NATIVE_TMP}
  )
  target_link_libraries(effect_runtime PUBLIC
    gpu_backend
    nlohmann_json::nlohmann_json
  )
  # Suppress noise about ignored WASM-only __attribute__((import_module))
  # annotations on the effect host-import declarations.
  target_compile_options(effect_runtime PRIVATE -Wno-attributes)

  # Per-effect MSL header generation. Reads .spv files emitted by the
  # WASM build; depends on them having been produced (the build script
  # fails loudly if not). Re-runs whenever the script or any input .spv
  # changes.
  set(EFFECT_MSL_HEADERS
    "${EFFECTS_NATIVE_TMP}/soft_glow_msl.h"
    "${EFFECTS_NATIVE_TMP}/motion_blur_msl.h"
    "${EFFECTS_NATIVE_TMP}/brightness_contrast_msl.h"
  )
  add_custom_command(
    OUTPUT ${EFFECT_MSL_HEADERS}
    COMMAND bash ${CMAKE_SOURCE_DIR}/effects_native/build_msl_headers.sh
    DEPENDS
      ${CMAKE_SOURCE_DIR}/effects_native/build_msl_headers.sh
      ${EFFECTS_NATIVE_TMP}/soft_glow_color.spv
      ${EFFECTS_NATIVE_TMP}/soft_glow_motion.spv
      ${EFFECTS_NATIVE_TMP}/motion_blur_reconstruct.spv
      ${EFFECTS_NATIVE_TMP}/motion_blur_pyramid_reduce.spv
      ${EFFECTS_NATIVE_TMP}/brightness_contrast_compute.spv
      ${EFFECTS_NATIVE_TMP}/brightness_contrast_pixel.spv
    COMMENT "Translating effect SPV → MSL headers via spirv-cross"
    VERBATIM
  )
  add_custom_target(effects_msl_headers DEPENDS ${EFFECT_MSL_HEADERS})

  # Effects compiled as native objects. Each effect's main.cpp is the
  # same source compiled for WASM; the namespace wrappers
  # (namespace soft_glow { ... }, namespace motion_blur { ... })
  # prevent symbol collisions.
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
  )
  target_include_directories(sketch_executor PUBLIC ${CMAKE_SOURCE_DIR}/src)
  target_link_libraries(sketch_executor PUBLIC
    sketch_augment
    effect_runtime
    gpu_backend
    nlohmann_json::nlohmann_json
  )

  add_library(effects_native STATIC
    wasm_modules/soft_glow/main.cpp
    wasm_modules/motion_blur/main.cpp
    wasm_modules/brightness_contrast/main.cpp
  )
  target_include_directories(effects_native PUBLIC
    ${EFFECTS_NATIVE_INC}
    ${EFFECTS_NATIVE_TMP}
  )
  target_link_libraries(effects_native PUBLIC effect_runtime)
  # Same attribute-noise filter.
  target_compile_options(effects_native PRIVATE -Wno-attributes)
  # The .spv headers (soft_glow_shaders.h) are inputs to the native
  # compile too. Add MSL header target as a build-order dep so it's
  # generated before anything that consumes it.
  add_dependencies(effects_native effects_msl_headers)

  # Config-driven CLI test runner — JSON config on stdin, JSON pixel
  # result on stdout. Mirrors web/public/gpu-test-runner.html for the
  # dual-backend tests.
  add_executable(native_test_runner tools/native_test_runner.mm)
  target_include_directories(native_test_runner PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${EFFECTS_NATIVE_INC}
    ${EFFECTS_NATIVE_TMP}
  )
  target_link_libraries(native_test_runner PRIVATE
    effects_native
    effect_runtime
    gpu_backend
    nlohmann_json::nlohmann_json
    "-framework Metal"
    "-framework Foundation"
  )
  target_compile_options(native_test_runner PRIVATE -Wno-attributes)

  # --- ffgl_runner: standalone host that dlopens an FFGL bundle ---
  # Lets me iterate on StreakyBlobs without restarting Resolume — feed
  # it a bundle path, get back stderr logs + an output PNG.
  add_executable(ffgl_runner
    tools/ffgl_runner.mm
    src/plugin/streaky_blobs/InteropTexture.m
  )
  target_include_directories(ffgl_runner PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${CMAKE_SOURCE_DIR}/src/plugin/streaky_blobs
  )
  target_link_libraries(ffgl_runner PRIVATE
    ffgl::sdk
    "-framework OpenGL"
    "-framework Metal"
    "-framework MetalKit"
    "-framework CoreVideo"
    "-framework AppKit"
    "-framework Foundation"
    z
  )
  target_compile_options(ffgl_runner PRIVATE -Wno-attributes -Wno-deprecated-declarations)

  # --- nano.StreakyBlobs FFGL bundle ---
  # Standalone .bundle (alongside NanoRepatch / NanoLooper) — links
  # effects_native + effect_runtime + gpu_backend statically. No
  # bridge_server.dylib. The GL↔Metal interop comes from the
  # InteropTexture borrowed from /Users/nattos/Code/nano-ffglify.
  add_library(StreakyBlobs MODULE
    src/plugin/streaky_blobs/streaky_blobs_plugin.mm
    src/plugin/streaky_blobs/InteropTexture.m
  )
  target_include_directories(StreakyBlobs PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${EFFECTS_NATIVE_INC}
    ${EFFECTS_NATIVE_TMP}
    ${CMAKE_SOURCE_DIR}/src/plugin/streaky_blobs
  )
  target_link_libraries(StreakyBlobs PRIVATE
    effects_native
    effect_runtime
    gpu_backend
    ffgl::sdk
    "-framework OpenGL"
    "-framework Metal"
    "-framework MetalKit"
    "-framework CoreVideo"
    "-framework AppKit"
    "-framework Foundation"
  )
  target_compile_options(StreakyBlobs PRIVATE -Wno-attributes -Wno-deprecated-declarations)
  set_target_properties(StreakyBlobs PROPERTIES
    BUNDLE TRUE
    BUNDLE_EXTENSION "bundle"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_SOURCE_DIR}/src/plugin/Info.plist.in"
    LINK_FLAGS "-undefined dynamic_lookup"
  )

  # Sign the bundle. STREAKYBLOBS_CODESIGN_IDENTITY can override at
  # configure time — e.g. for a self-signed cert created via Keychain
  # Access:
  #   cmake -DSTREAKYBLOBS_CODESIGN_IDENTITY="Nano StreakyBlobs Self-Signed" ..
  # Or for a notarizable build:
  #   cmake -DSTREAKYBLOBS_CODESIGN_IDENTITY="Developer ID Application: Name (TEAMID)" ..
  # Default is `-` (ad-hoc); the helper script fails loudly if the
  # named identity isn't in the keychain rather than silently falling
  # back to ad-hoc, which would force end-users to re-approve the
  # plugin in System Settings after every rebuild.
  if(NOT DEFINED STREAKYBLOBS_CODESIGN_IDENTITY)
    set(STREAKYBLOBS_CODESIGN_IDENTITY "-")
  endif()
  add_custom_command(TARGET StreakyBlobs POST_BUILD
    COMMAND bash ${CMAKE_SOURCE_DIR}/tools/codesign_bundle.sh
            "${STREAKYBLOBS_CODESIGN_IDENTITY}"
            $<TARGET_BUNDLE_DIR:StreakyBlobs>
    COMMENT "Codesigning StreakyBlobs.bundle (identity=${STREAKYBLOBS_CODESIGN_IDENTITY})"
    VERBATIM
  )

  # --- NanoBarrel FFGL bundle ---
  # The full-fat barrel: one FFGL bundle that hosts a sketch + bridge
  # (FF_TYPE_FILE config persisted by Resolume + per-instance WS) AND
  # executes the sketch each frame via the Metal-backed effect runtime.
  # Mirrors the StreakyBlobs link set — same effects_native / runtime /
  # gpu_backend dependency, same InteropTexture for GL↔Metal.
  set(FFGL_BUNDLE_LINK_FLAGS_BARREL "-undefined dynamic_lookup")
  add_library(NanoBarrel MODULE
    src/plugin/nano_barrel/nano_barrel_plugin.mm
    src/plugin/nano_barrel/InteropTexture.m
  )
  target_include_directories(NanoBarrel PRIVATE
    ${CMAKE_SOURCE_DIR}/src
    ${EFFECTS_NATIVE_INC}
    ${EFFECTS_NATIVE_TMP}
    ${CMAKE_SOURCE_DIR}/src/plugin/nano_barrel
  )
  target_link_libraries(NanoBarrel PRIVATE
    effects_native
    sketch_executor      # brings in sketch_augment + effect_runtime + gpu_backend
    bridge_core
    bridge_ws_server
    state_system
    param_cache
    resolume_protocol
    json_utils
    nlohmann_json::nlohmann_json
    ixwebsocket
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
  add_custom_command(TARGET NanoBarrel POST_BUILD
    COMMAND bash ${CMAKE_SOURCE_DIR}/tools/codesign_bundle.sh
            "${NANOBARREL_CODESIGN_IDENTITY}"
            $<TARGET_BUNDLE_DIR:NanoBarrel>
    COMMENT "Codesigning NanoBarrel.bundle (identity=${NANOBARREL_CODESIGN_IDENTITY})"
    VERBATIM
  )

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
    ${EFFECTS_NATIVE_TMP}
    ${CMAKE_SOURCE_DIR}/src/plugin/nano_barrel
  )
  target_link_libraries(benchmark_barrel PRIVATE
    effects_native
    sketch_executor
    nlohmann_json::nlohmann_json
    "-framework OpenGL"
    "-framework Metal"
    "-framework CoreVideo"
    "-framework AppKit"
    "-framework Foundation"
  )
  target_compile_options(benchmark_barrel PRIVATE -Wno-deprecated-declarations)
endif()
