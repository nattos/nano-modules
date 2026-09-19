// test_spv_to_hlsl.cpp — the SPIR-V → HLSL round trip, over EVERY baked shader.
//
// Effects author HLSL; DXC bakes SPIR-V; on Windows we translate back to HLSL
// for D3DCompile. This is the sweep that answers "do all ~380 shaders survive
// the round trip", and it runs on macOS — where the goldens are — so a shader
// that D3D could never bind is caught by the normal build, not by a Windows
// run nobody does.
//
// The two properties that matter are not "it produced output":
//
//   1. REGISTER IDENTITY. `register(t1)` became SPIR-V binding 1, and the host
//      binds by that number. Auto-assigned registers would mis-bind silently.
//   2. THREADGROUP SIZE. HLSL carries it in [numthreads]; the Metal path needs
//      a comment because MSL cannot express it at all.
//
// Both are checked against the SPIR-V decoded HERE, by hand, rather than
// against spirv-cross's own reflection — otherwise the test would be asking
// the translator to confirm its own story.

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "runtime/spv_to_hlsl.h"

#if defined(_WIN32)
#include <windows.h>
#include <d3dcompiler.h>
#endif

#ifndef SPV_DIR
#error "SPV_DIR must be defined"
#endif

namespace {

std::vector<uint32_t> loadWords(const std::filesystem::path& p) {
  std::ifstream f(p, std::ios::binary | std::ios::ate);
  if (!f) return {};
  auto size = static_cast<size_t>(f.tellg());
  if (size < 4 || size % 4) return {};
  f.seekg(0);
  std::vector<uint32_t> w(size / 4);
  f.read(reinterpret_cast<char*>(w.data()), static_cast<std::streamsize>(size));
  return w;
}

struct SpvFacts {
  std::set<uint32_t> bindings;
  uint32_t localSize[3] = {0, 0, 0};
  uint32_t stage = 0xffffffffu;   // SPIR-V ExecutionModel
  bool isCompute = false;
};

// A minimal SPIR-V walk: the header is 5 words, then a stream of instructions
// whose high half-word is the length. We only care about three opcodes.
SpvFacts decode(const std::vector<uint32_t>& w) {
  SpvFacts f;
  if (w.size() < 5 || w[0] != 0x07230203u) return f;
  for (size_t i = 5; i < w.size();) {
    uint32_t len = w[i] >> 16, op = w[i] & 0xffffu;
    if (len == 0 || i + len > w.size()) break;
    if (op == 71 /*OpDecorate*/ && len >= 4 && w[i + 2] == 33 /*Binding*/)
      f.bindings.insert(w[i + 3]);
    if (op == 15 /*OpEntryPoint*/ && len >= 3) {
      f.stage = w[i + 1];
      f.isCompute = (f.stage == 5 /*GLCompute*/);
    }
    if (op == 16 /*OpExecutionMode*/ && len >= 6 && w[i + 2] == 17 /*LocalSize*/)
      for (int k = 0; k < 3; ++k) f.localSize[k] = w[i + 3 + k];
    i += len;
  }
  return f;
}

// Every `register(<letter><number>...)` in the generated source.
std::vector<std::pair<char, uint32_t>> registersIn(const std::string& hlsl) {
  std::vector<std::pair<char, uint32_t>> out;
  for (size_t at = hlsl.find("register("); at != std::string::npos;
       at = hlsl.find("register(", at + 1)) {
    size_t i = at + 9;
    if (i >= hlsl.size()) break;
    char letter = hlsl[i++];
    uint32_t n = 0;
    bool any = false;
    while (i < hlsl.size() && hlsl[i] >= '0' && hlsl[i] <= '9') {
      n = n * 10 + static_cast<uint32_t>(hlsl[i++] - '0');
      any = true;
    }
    if (any) out.push_back({letter, n});
  }
  return out;
}

std::vector<std::filesystem::path> allSpv() {
  std::vector<std::filesystem::path> v;
  std::error_code ec;
  // SPV_DIR is baked at configure time and points into the source tree, which
  // a cross-compiled binary cannot see — under CrossOver the shaders are
  // copied into the bottle and named through the environment instead.
  const char* dir = std::getenv("NANO_SPV_DIR");
  if (!dir || !*dir) dir = SPV_DIR;
  for (auto& e : std::filesystem::directory_iterator(dir, ec))
    if (e.path().extension() == ".spv") v.push_back(e.path());
  std::sort(v.begin(), v.end());
  return v;
}

}  // namespace

TEST_CASE("every baked shader survives the SPIR-V -> HLSL round trip",
          "[spv_to_hlsl]") {
  auto files = allSpv();
  REQUIRE(files.size() > 300);  // the sweep is the point; a stub dir isn't it

  std::vector<std::string> failures;
  for (const auto& p : files) {
    auto words = loadWords(p);
    if (words.empty()) { failures.push_back(p.filename().string() + ": unreadable"); continue; }
    std::string err;
    std::string hlsl = effect_runtime::spvToHlsl(
        reinterpret_cast<const uint8_t*>(words.data()), words.size() * 4, &err);
    if (hlsl.empty()) failures.push_back(p.filename().string() + ": " + err);
  }
  // Name them all — "N failed" would mean re-running the sweep by hand to
  // find out which, and the b14 case is already known to be in here.
  for (const auto& f : failures) UNSCOPED_INFO(f);
  CHECK(failures.empty());
  std::printf("[spv_to_hlsl] %zu/%zu shaders translated\n",
              files.size() - failures.size(), files.size());
}

TEST_CASE("registers round-trip to their SPIR-V binding numbers",
          "[spv_to_hlsl]") {
  std::vector<std::string> problems;
  size_t checked = 0;
  for (const auto& p : allSpv()) {
    auto words = loadWords(p);
    if (words.empty()) continue;
    std::string hlsl = effect_runtime::spvToHlsl(
        reinterpret_cast<const uint8_t*>(words.data()), words.size() * 4);
    if (hlsl.empty()) continue;  // the sweep above owns translation failures
    SpvFacts facts = decode(words);
    std::map<char, std::set<uint32_t>> seen;
    for (auto [letter, n] : registersIn(hlsl)) {
      ++checked;
      // A number spirv-cross invented would not appear in the SPIR-V at all.
      if (!facts.bindings.count(n))
        problems.push_back(p.filename().string() + ": register(" + letter +
                           std::to_string(n) + ") is not a SPIR-V binding");
      // Two resources in one register space is an outright mis-bind.
      if (!seen[letter].insert(n).second)
        problems.push_back(p.filename().string() + ": register " + letter +
                           std::to_string(n) + " used twice");
    }
  }
  for (const auto& f : problems) UNSCOPED_INFO(f);
  CHECK(problems.empty());
  CHECK(checked > 500);  // guard against the loop silently matching nothing
}

TEST_CASE("[numthreads] matches the SPIR-V LocalSize", "[spv_to_hlsl]") {
  std::vector<std::string> problems;
  size_t compute = 0;
  for (const auto& p : allSpv()) {
    auto words = loadWords(p);
    if (words.empty()) continue;
    SpvFacts facts = decode(words);
    if (!facts.isCompute || facts.localSize[0] == 0) continue;
    std::string hlsl = effect_runtime::spvToHlsl(
        reinterpret_cast<const uint8_t*>(words.data()), words.size() * 4);
    if (hlsl.empty()) continue;
    ++compute;
    std::string want = "[numthreads(" + std::to_string(facts.localSize[0]) +
                       ", " + std::to_string(facts.localSize[1]) + ", " +
                       std::to_string(facts.localSize[2]) + ")]";
    if (hlsl.find(want) == std::string::npos)
      problems.push_back(p.filename().string() + ": expected " + want);
  }
  for (const auto& f : problems) UNSCOPED_INFO(f);
  CHECK(problems.empty());
  CHECK(compute > 200);
}

TEST_CASE("spvToHlsl rejects invalid input", "[spv_to_hlsl]") {
  std::string err;
  CHECK(effect_runtime::spvToHlsl(nullptr, 0, &err).empty());
  CHECK(!err.empty());
  const uint8_t junk[5] = {1, 2, 3, 4, 5};
  CHECK(effect_runtime::spvToHlsl(junk, 5).empty());   // not a multiple of 4
  const uint8_t notspv[8] = {0, 0, 0, 0, 0, 0, 0, 0};
  CHECK(effect_runtime::spvToHlsl(notspv, 8).empty());  // bad magic
}

#if defined(_WIN32)
// ---------------------------------------------------------------------------
// The Windows leg: does FXC actually accept what spirv-cross emitted?
//
// Everything above is a property of the TEXT. This is the only part that asks
// the real compiler, and it is the gate the whole stage exists for — a shader
// that translates cleanly and then fails to compile is still a dead effect.
//
// It needs Microsoft's d3dcompiler_47.dll. Wine's builtin rejects valid HLSL
// (it has no RWByteAddressBuffer::InterlockedAdd, which spirv-cross emits for
// every storage buffer), so a run without the native override would report
// dozens of failures that are nothing to do with these shaders. Refuse to run
// rather than produce that.
namespace {

const char* profileFor(uint32_t stage) {
  switch (stage) {
    case 0: return "vs_5_0";
    case 4: return "ps_5_0";
    case 5: return "cs_5_0";
    default: return nullptr;
  }
}

}  // namespace

TEST_CASE("every translated shader compiles to DXBC", "[spv_to_hlsl][d3d]") {
  HMODULE lib = LoadLibraryA("d3dcompiler_47.dll");
  REQUIRE(lib != nullptr);
  auto compile = reinterpret_cast<pD3DCompile>(GetProcAddress(lib, "D3DCompile"));
  REQUIRE(compile != nullptr);

  // Microsoft's DLL sits next to the exe; wine's builtin lives in the fake
  // windows directory. If we got the latter, the results are meaningless.
  char path[MAX_PATH] = {0};
  GetModuleFileNameA(lib, path, MAX_PATH);
  std::string where(path);
  std::string lowered;
  for (char c : where) lowered += static_cast<char>(std::tolower(c));
  INFO("d3dcompiler_47.dll loaded from " << where);
  REQUIRE(lowered.find("\\windows\\") == std::string::npos);

  std::vector<std::string> failures;
  size_t compiled = 0;
  for (const auto& p : allSpv()) {
    auto words = loadWords(p);
    if (words.empty()) continue;
    std::string hlsl = effect_runtime::spvToHlsl(
        reinterpret_cast<const uint8_t*>(words.data()), words.size() * 4);
    if (hlsl.empty()) continue;  // the translation sweep owns those
    const char* profile = profileFor(decode(words).stage);
    if (!profile) { failures.push_back(p.filename().string() + ": unknown stage"); continue; }

    ID3DBlob* code = nullptr;
    ID3DBlob* errors = nullptr;
    HRESULT hr = compile(hlsl.data(), hlsl.size(), p.filename().string().c_str(),
                         nullptr, nullptr, "main", profile, 0, 0, &code, &errors);
    if (FAILED(hr) || !code) {
      std::string msg = errors ? std::string(
          static_cast<const char*>(errors->GetBufferPointer())) : "no diagnostic";
      if (msg.size() > 300) msg.resize(300);
      failures.push_back(p.filename().string() + " [" + profile + "]: " + msg);
    } else {
      ++compiled;
    }
    if (code) code->Release();
    if (errors) errors->Release();
  }
  for (const auto& f : failures) UNSCOPED_INFO(f);
  CHECK(failures.empty());
  std::printf("[spv_to_hlsl] %zu shaders compiled to DXBC\n", compiled);
}
#endif  // _WIN32
