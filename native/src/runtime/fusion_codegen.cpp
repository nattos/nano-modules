#include "runtime/fusion_codegen.h"

#include <cstdio>
#include <string>
#include <string_view>
#include <vector>

namespace fusion_codegen {

namespace {

// Find a balanced `{ ... }` block whose opening `{` is the first one
// after `from`. Returns the position one past the matching `}` (so the
// extracted block is `[blockStart, end)`). On unbalanced input returns
// std::string::npos.
size_t findBalancedBlockEnd(const std::string& s, size_t from) {
  size_t open = s.find('{', from);
  if (open == std::string::npos) return std::string::npos;
  int depth = 0;
  for (size_t i = open; i < s.size(); ++i) {
    char c = s[i];
    if (c == '{') ++depth;
    else if (c == '}') {
      if (--depth == 0) return i + 1;
    }
  }
  return std::string::npos;
}

// Extract `struct type_ConstantBuffer_FuseUniforms { ... };` and rename
// it to `FU_<idx>`. Returns the rewritten declaration including the
// trailing `;`, or empty on failure.
std::string extractAndRenameStruct(const std::string& src, int idx) {
  static constexpr const char* kStructName =
      "type_ConstantBuffer_FuseUniforms";
  size_t at = src.find(std::string("struct ") + kStructName);
  if (at == std::string::npos) return "";
  size_t end = findBalancedBlockEnd(src, at);
  if (end == std::string::npos) return "";
  // Sweep over the trailing `;` (may be preceded by whitespace).
  while (end < src.size() && (src[end] == ' ' || src[end] == '\n' ||
                              src[end] == '\r' || src[end] == '\t')) {
    ++end;
  }
  if (end < src.size() && src[end] == ';') ++end;
  std::string block = src.substr(at, end - at);
  // Single rename pass: there's only one mention of the struct name
  // inside the struct itself (the `struct <name>` header).
  std::string newName = "FU_" + std::to_string(idx);
  std::string out;
  out.reserve(block.size() + 8);
  for (size_t i = 0; i < block.size();) {
    if (i + std::char_traits<char>::length(kStructName) <= block.size() &&
        block.compare(i, std::char_traits<char>::length(kStructName),
                      kStructName) == 0) {
      out.append(newName);
      i += std::char_traits<char>::length(kStructName);
    } else {
      out.push_back(block[i++]);
    }
  }
  return out;
}

// Word-boundary rename of every `from` occurrence in `s` to `to`.
void renameIdent(std::string& s, const std::string& from, const std::string& to) {
  if (from.empty()) return;
  std::string out;
  out.reserve(s.size());
  size_t i = 0;
  while (i < s.size()) {
    if (i + from.size() <= s.size() && s.compare(i, from.size(), from) == 0) {
      bool lhs = (i == 0)
          || !(isalnum((unsigned char)s[i - 1]) || s[i - 1] == '_');
      bool rhs = (i + from.size() == s.size())
          || !(isalnum((unsigned char)s[i + from.size()])
                || s[i + from.size()] == '_');
      if (lhs && rhs) { out.append(to); i += from.size(); continue; }
    }
    out.push_back(s[i++]);
  }
  s = std::move(out);
}

// Extract ALL the helper functions PLUS `fuse_transform` from one effect's
// pixel MSL — everything from the first `static inline` up to the `kernel void`
// entry (which we drop; the fused kernel is generated separately). Each
// user-defined function is suffixed with `_<idx>` so helpers of the same name in
// different fused stages (e.g. two effects' `saturate_channel`) don't collide;
// `fuse_transform` becomes `ft_<idx>` (the name the fused kernel calls), and the
// uniform struct becomes `FU_<idx>`. spirv-cross emits each function as
// `static inline __attribute__((always_inline))\n<ret> <name>(...)`.
std::string extractAndRenameFunction(const std::string& src, int idx) {
  size_t start = src.find("static inline");
  if (start == std::string::npos) return "";
  size_t end = src.find("kernel void");           // drop the compute entry
  if (end == std::string::npos) end = src.size();
  std::string block = src.substr(start, end - start);

  // Collect every user function name (the identifier just before the `(` that
  // follows each `always_inline))` marker), so we can rename defs AND calls.
  std::vector<std::string> funcNames;
  for (size_t p = 0; (p = block.find("always_inline))", p)) != std::string::npos; ) {
    size_t paren = block.find('(', p);
    if (paren == std::string::npos) break;
    size_t e = paren;
    while (e > 0 && (block[e - 1] == ' ' || block[e - 1] == '\n' ||
                     block[e - 1] == '\r' || block[e - 1] == '\t')) --e;
    size_t s = e;
    while (s > 0 && (isalnum((unsigned char)block[s - 1]) || block[s - 1] == '_')) --s;
    if (e > s) funcNames.push_back(block.substr(s, e - s));
    p = paren;
  }

  const std::string suffix = "_" + std::to_string(idx);
  for (const auto& name : funcNames) {
    if (name == "fuse_transform") continue;       // handled below → ft_<idx>
    renameIdent(block, name, name + suffix);       // helper → helper_<idx>
  }
  renameIdent(block, "fuse_transform", "ft_" + std::to_string(idx));
  renameIdent(block, "type_ConstantBuffer_FuseUniforms", "FU_" + std::to_string(idx));
  return block;
}

}  // namespace

std::string generateFusedMSL(const std::vector<std::string>& pixelMSLs) {
  if (pixelMSLs.empty()) return "";

  std::string structs;
  std::string functions;
  for (size_t i = 0; i < pixelMSLs.size(); ++i) {
    std::string s = extractAndRenameStruct(pixelMSLs[i], (int)i);
    std::string f = extractAndRenameFunction(pixelMSLs[i], (int)i);
    if (s.empty() || f.empty()) return "";
    structs  += s + "\n\n";
    functions += f + "\n\n";
  }

  std::string out;
  out.reserve(structs.size() + functions.size() + 1024);
  out += "#include <metal_stdlib>\n";
  out += "#include <simd/simd.h>\n";
  out += "using namespace metal;\n\n";
  out += structs;
  out += functions;
  out += "kernel void fused_main(\n";
  out += "    texture2d<float, access::read>  tex_in  [[texture(0)]],\n";
  out += "    texture2d<float, access::write> tex_out [[texture(1)]],\n";
  for (size_t i = 0; i < pixelMSLs.size(); ++i) {
    char line[128];
    std::snprintf(line, sizeof(line),
                  "    constant FU_%zu& u%zu [[buffer(%zu)]],\n",
                  i, i, 2 + i);
    out += line;
  }
  out += "    uint3 gid_in [[thread_position_in_grid]])\n";
  out += "{\n";
  out += "  uint W = tex_out.get_width();\n";
  out += "  uint H = tex_out.get_height();\n";
  out += "  uint2 gid = gid_in.xy;\n";
  out += "  if (gid.x >= W || gid.y >= H) return;\n";
  out += "  float4 c = tex_in.read(gid);\n";
  for (size_t i = 0; i < pixelMSLs.size(); ++i) {
    char line[64];
    std::snprintf(line, sizeof(line),
                  "  c = ft_%zu(gid, c, u%zu);\n", i, i);
    out += line;
  }
  out += "  tex_out.write(c, gid);\n";
  out += "}\n";
  return out;
}

}  // namespace fusion_codegen
