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
  target_include_directories(gpu_backend PUBLIC ${CMAKE_SOURCE_DIR}/src)
  target_link_libraries(gpu_backend PUBLIC
    "-framework Metal"
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
