// Stage 0: prove the cross-compile toolchain, AND exercise the nine _WIN32
// branches in platform/paths.h that have never once been executed — they were
// written ahead of a Windows host existing, so nothing has ever checked them.
#include <catch2/catch_test_macros.hpp>

#include <cstdio>
#include <string>

#include "platform/paths.h"

/// An address guaranteed to live in this executable — what imagePathContaining wants.
static void selfAnchor() {}

TEST_CASE("the toolchain produces a running Windows binary", "[smoke]") {
  // Sizes, not values: catches a 32-bit/64-bit or ABI mix-up immediately.
  REQUIRE(sizeof(void*) == 8);
  REQUIRE(std::string("nano").size() == 4);
}

TEST_CASE("mingw printf understands %zu and %lld", "[smoke]") {
  // MSVCRT's printf does not, and __USE_MINGW_ANSI_STDIO=1 is what fixes it.
  // Several bridge and GPU files format sizes this way; without the define they
  // print literal "zu" and the logs quietly become useless.
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%zu/%lld", (size_t)42, (long long)-7);
  REQUIRE(std::string(buf) == "42/-7");
}

TEST_CASE("paths.h joins and splits Windows paths", "[smoke][paths]") {
  using namespace nano_paths;
  // isSep must accept BOTH separators on Windows — Resolume, the install record
  // and our own env vars do not agree on which one they hand us.
  REQUIRE(parentDir("C:\\nano\\resources\\wasm") == "C:\\nano\\resources");
  REQUIRE(parentDir("C:/nano/resources/wasm") == "C:/nano/resources");
  const std::string j = joinPath("C:\\nano", "wasm");
  INFO("joinPath gave: " << j);
  REQUIRE(j.find("nano") != std::string::npos);
  REQUIRE(j.find("wasm") != std::string::npos);
}

TEST_CASE("paths.h resolves the Windows support and log dirs", "[smoke][paths]") {
  using namespace nano_paths;
  // %APPDATA%\NanoBarrel and %LOCALAPPDATA%\<name>\Logs. This is the directory
  // the Electron install record already lands in under CrossOver, computed by
  // the JS side with neither half told about the other — so agreement here is
  // the thing worth checking.
  const std::string support = supportDirPath();
  INFO("supportDirPath: " << support);
  REQUIRE_FALSE(support.empty());
  REQUIRE(support.find("NanoBarrel") != std::string::npos);

  const std::string logs = logDir("NanoSmoke");
  INFO("logDir: " << logs);
  REQUIRE_FALSE(logs.empty());
  REQUIRE(logs.find("NanoSmoke") != std::string::npos);
}

TEST_CASE("paths.h finds the image it is loaded in", "[smoke][paths]") {
  using namespace nano_paths;
  // GetModuleHandleExW(FROM_ADDRESS) + GetModuleFileNameW on Windows; dladdr on
  // POSIX. resource_root.h's whole walk hangs off this, so if it returns empty
  // the plugin resolves no effects at all.
  const std::string self = imagePathContaining(reinterpret_cast<const void*>(&selfAnchor));
  INFO("imagePathContaining: " << self);
  REQUIRE_FALSE(self.empty());
}

TEST_CASE("paths.h answers questions about the filesystem", "[smoke][paths]") {
  using namespace nano_paths;
  REQUIRE(dirExists("C:\\windows"));
  REQUIRE_FALSE(dirExists("C:\\definitely-not-here-9f3a"));
  REQUIRE_FALSE(fileExists("C:\\definitely-not-here-9f3a\\x.txt"));
}
