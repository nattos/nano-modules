# Cross-compile the native tree to Windows x64 from macOS, using zig as the
# C/C++ driver (it bundles the mingw-w64 headers and import libs, so there is no
# Windows SDK and no Windows machine in the loop).
#
# Prior art: tools/win_gpu_probe/build.sh cross-builds D3D11/D3D12 test programs
# this way already, and they run under CrossOver against the real GPU.
#
#   cmake -B build-win -DCMAKE_TOOLCHAIN_FILE=cmake/toolchain-win-zig.cmake
#
# Override the triple with NANO_ZIG_TARGET (the wrappers read it).

set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

get_filename_component(_nano_cmake_dir "${CMAKE_CURRENT_LIST_DIR}" ABSOLUTE)
set(CMAKE_C_COMPILER   "${_nano_cmake_dir}/zig-cc")
set(CMAKE_CXX_COMPILER "${_nano_cmake_dir}/zig-cxx")
set(CMAKE_AR           "${_nano_cmake_dir}/zig-ar"     CACHE FILEPATH "" FORCE)
set(CMAKE_RANLIB       "${_nano_cmake_dir}/zig-ranlib" CACHE FILEPATH "" FORCE)

# zig cc is clang underneath, but CMake only infers that once it has run its
# detection; saying so up front keeps the GNU-style flag tables in play.
set(CMAKE_C_COMPILER_ID   Clang)
set(CMAKE_CXX_COMPILER_ID Clang)

# mingw's default printf is MSVCRT's, which does not understand %zu or %lld and
# prints literal garbage. Several bridge/GPU files use both.
add_compile_definitions(__USE_MINGW_ANSI_STDIO=1)

# Look for headers/libs in the target sysroot, never the host's /usr/local.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM BEFORE)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
