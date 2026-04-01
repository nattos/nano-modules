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
set(WAMR_BUILD_LIBC_WASI 0)
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

# --- Param Cache library ---
add_library(param_cache STATIC
  src/bridge/param_cache.cpp
)
target_include_directories(param_cache PUBLIC ${CMAKE_SOURCE_DIR}/src)

# --- Resolume Protocol library ---
add_library(resolume_protocol STATIC
  src/resolume/protocol.cpp
)
target_include_directories(resolume_protocol PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(resolume_protocol PUBLIC nlohmann_json::nlohmann_json)

# --- WASM Host library ---
add_library(wasm_host STATIC
  src/wasm/wasm_host.cpp
  src/wasm/host_functions.cpp
)
target_include_directories(wasm_host PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(wasm_host PUBLIC param_cache vmlib)

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

# --- Bridge Server shared library (dylib) ---
add_library(bridge_server SHARED
  src/bridge/bridge_server.cpp
  src/bridge/bridge_api.cpp
  src/bridge/param_cache.cpp
)
target_include_directories(bridge_server PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_link_libraries(bridge_server PRIVATE
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
endif()

# --- Bridge Harness (manual testing tool) ---
add_executable(gen_wasm tools/gen_wasm.cpp)

add_executable(bridge_harness tools/bridge_harness.cpp)
target_link_libraries(bridge_harness PRIVATE bridge_loader)
target_compile_definitions(bridge_harness PRIVATE
  BRIDGE_DYLIB_PATH="$<TARGET_FILE:bridge_server>"
)
