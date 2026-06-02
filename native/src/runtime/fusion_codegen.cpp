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

// Find `float4 fuse_transform(...)` (the first occurrence) and return
// the full function definition with `fuse_transform` renamed to
// `ft_<idx>` and references to `type_ConstantBuffer_FuseUniforms`
// renamed to `FU_<idx>`.
std::string extractAndRenameFunction(const std::string& src, int idx) {
  size_t hdr = src.find("fuse_transform");
  if (hdr == std::string::npos) return "";
  // Walk backwards over the return-type / attribute soup to the start
  // of the line so we keep the inline annotation.
  size_t start = hdr;
  // Look back ~256 bytes for the start of the declaration; the
  // spirv-cross output puts `static inline __attribute__((always_inline))`
  // (or similar) on the preceding line.
  size_t lookback = start > 256 ? start - 256 : 0;
  size_t lineStart = src.rfind("\n", start);
  // Walk further back through any continuation lines that end with
  // an identifier/`)` (attribute annotations).
  while (lineStart != std::string::npos && lineStart > lookback) {
    size_t prev = src.rfind("\n", lineStart - 1);
    size_t scanFrom = (prev == std::string::npos) ? 0 : prev + 1;
    std::string_view ln(src.data() + scanFrom, lineStart - scanFrom);
    // Stop if this prior line is blank or contains `;` or `}` — it
    // belongs to a different declaration.
    bool blank = true;
    for (char c : ln) {
      if (c != ' ' && c != '\t') { blank = false; break; }
    }
    if (blank) break;
    if (ln.find(';') != std::string_view::npos) break;
    if (ln.find('}') != std::string_view::npos) break;
    lineStart = (prev == std::string::npos) ? std::string::npos : prev;
  }
  start = (lineStart == std::string::npos) ? 0 : lineStart + 1;

  size_t end = findBalancedBlockEnd(src, hdr);
  if (end == std::string::npos) return "";
  std::string block = src.substr(start, end - start);

  // Two rewrites: function name + struct name.
  auto rename = [&](const std::string& from, const std::string& to) {
    std::string out;
    out.reserve(block.size());
    size_t i = 0;
    while (i < block.size()) {
      if (i + from.size() <= block.size() &&
          block.compare(i, from.size(), from) == 0) {
        // Check word boundary so we don't rewrite a longer identifier
        // that happens to contain `from` as a prefix/suffix.
        bool lhsBoundary = (i == 0)
            || !(isalnum((unsigned char)block[i - 1]) || block[i - 1] == '_');
        bool rhsBoundary = (i + from.size() == block.size())
            || !(isalnum((unsigned char)block[i + from.size()])
                  || block[i + from.size()] == '_');
        if (lhsBoundary && rhsBoundary) {
          out.append(to);
          i += from.size();
          continue;
        }
      }
      out.push_back(block[i++]);
    }
    block = std::move(out);
  };
  rename("fuse_transform", "ft_" + std::to_string(idx));
  rename("type_ConstantBuffer_FuseUniforms", "FU_" + std::to_string(idx));
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
