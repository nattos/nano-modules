# Stage 0 toolchain probe: does this repo's C++ cross-compile to Windows, build
# a real third-party library, and run under CrossOver?
#
# Deliberately standalone. The main CMakeLists cannot configure off macOS yet
# (it declares OBJCXX), and the point of this target is to retire the TOOLCHAIN
# risk before touching that.
#
#   cmake -B build-win-smoke -S cmake/smoke \
#         -DCMAKE_TOOLCHAIN_FILE=../toolchain-win-zig.cmake
#   cmake --build build-win-smoke
cmake_minimum_required(VERSION 3.20)
project(nano_win_smoke LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
FetchContent_Declare(Catch2
  GIT_REPOSITORY https://github.com/catchorg/Catch2.git
  GIT_TAG v3.5.2)
FetchContent_MakeAvailable(Catch2)

add_executable(nano_win_smoke smoke.cpp)
# ../../src so platform/paths.h resolves exactly as it does in the real tree.
target_include_directories(nano_win_smoke PRIVATE ${CMAKE_CURRENT_LIST_DIR}/../../src)
target_link_libraries(nano_win_smoke PRIVATE Catch2::Catch2WithMain)
