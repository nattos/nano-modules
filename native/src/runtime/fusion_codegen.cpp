#include "runtime/fusion_codegen.h"

#include <cstdio>
#include <string>
#include <cctype>
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

// ---------------------------------------------------------------------------
// HLSL (D3D11). spirv-cross's HLSL output is a different shape from its MSL:
// the fuse uniforms come back as a `cbuffer` whose members are GLOBALS, not a
// struct passed by reference, and there is no `always_inline))` marker to find
// functions by. So neither anchor above survives, and this half scans the
// top-level structure instead: spirv-cross emits a flat sequence of resource
// declarations, a `struct SPIRV_Cross_Input`, the user's functions, and finally
// `comp_main` + `main`. Everything before `comp_main` that is a FUNCTION is
// what we want; everything else in that range is a declaration we re-emit or
// drop.
// ---------------------------------------------------------------------------

// One top-level item: `[begin, end)` plus what it is.
struct TopItem {
  size_t begin = 0, end = 0;
  bool isFunction = false;
  bool isCbuffer = false;
};

bool isIdentChar(char c) { return isalnum((unsigned char)c) || c == '_'; }

// Split `src[0 .. limit)` into top-level items. A declaration runs to its `;`;
// a block runs to the `}` that closes it (plus a trailing `;` if present).
std::vector<TopItem> topLevelItems(const std::string& src, size_t limit) {
  std::vector<TopItem> items;
  size_t i = 0;
  while (i < limit) {
    while (i < limit && isspace((unsigned char)src[i])) ++i;
    if (i >= limit) break;
    TopItem item;
    item.begin = i;
    int braces = 0, parens = 0;
    bool sawParenBeforeBrace = false, sawBrace = false;
    size_t j = i;
    for (; j < limit; ++j) {
      char c = src[j];
      if (c == '(') { ++parens; if (!sawBrace) sawParenBeforeBrace = true; }
      else if (c == ')') { --parens; }
      else if (c == '{') { ++braces; sawBrace = true; }
      else if (c == '}') {
        if (--braces == 0) {
          ++j;
          if (j < limit && src[j] == ';') ++j;
          break;
        }
      } else if (c == ';' && braces == 0 && parens == 0) {
        ++j;
        break;
      }
    }
    item.end = j < limit ? j : limit;
    const std::string head = src.substr(item.begin,
                                        item.end - item.begin < 16
                                            ? item.end - item.begin : 16);
    item.isCbuffer = head.compare(0, 7, "cbuffer") == 0;
    item.isFunction = sawBrace && sawParenBeforeBrace && !item.isCbuffer &&
                      head.compare(0, 6, "struct") != 0;
    items.push_back(item);
    i = item.end;
  }
  return items;
}

// Member identifiers of a `cbuffer ... { ... };` block: the token before the
// `:` of a packoffset (or before the `;` when spirv-cross omits one).
std::vector<std::string> cbufferMembers(const std::string& block) {
  std::vector<std::string> names;
  size_t open = block.find('{');
  size_t close = block.rfind('}');
  if (open == std::string::npos || close == std::string::npos) return names;
  size_t i = open + 1;
  while (i < close) {
    size_t semi = block.find(';', i);
    if (semi == std::string::npos || semi > close) break;
    size_t declEnd = semi;
    size_t colon = block.find(':', i);
    if (colon != std::string::npos && colon < semi) declEnd = colon;
    size_t e = declEnd;
    while (e > i && isspace((unsigned char)block[e - 1])) --e;
    size_t s = e;
    while (s > i && isIdentChar(block[s - 1])) --s;
    if (e > s) names.push_back(block.substr(s, e - s));
    i = semi + 1;
  }
  return names;
}

// One fused stage's HLSL, renamed so N of them can share a translation unit.
// Returns false if the source doesn't look like a fuse fragment.
bool rewriteStageHLSL(const std::string& src, int idx, std::string* cbufOut,
                      std::string* funcsOut) {
  const size_t limit = src.find("void comp_main()");
  if (limit == std::string::npos) return false;

  std::string cbuf, funcs;
  std::vector<std::string> funcNames;
  for (const TopItem& it : topLevelItems(src, limit)) {
    const std::string body = src.substr(it.begin, it.end - it.begin);
    if (it.isCbuffer) {
      if (!cbuf.empty()) return false;          // only one fuse cbuffer
      cbuf = body;
    } else if (it.isFunction) {
      // The name is the identifier before the first top-level `(`.
      size_t paren = body.find('(');
      if (paren == std::string::npos) return false;
      size_t e = paren;
      while (e > 0 && isspace((unsigned char)body[e - 1])) --e;
      size_t b = e;
      while (b > 0 && isIdentChar(body[b - 1])) --b;
      if (e <= b) return false;
      funcNames.push_back(body.substr(b, e - b));
      funcs += body;
      funcs += "\n\n";
    }
    // Everything else (the SPIRV_Cross_Input struct, `static uint3
    // gl_GlobalInvocationID;`, the `_fuse_out` UAV) belongs to the synthetic
    // wrapper entry and is dropped with it.
  }
  if (cbuf.empty() || funcNames.empty()) return false;

  const std::string sfx = "_" + std::to_string(idx);
  // Members first: a member could otherwise be shadowed by a function rename.
  for (const auto& m : cbufferMembers(cbuf)) {
    renameIdent(cbuf, m, m + sfx);
    renameIdent(funcs, m, m + sfx);
  }
  bool sawTransform = false;
  for (const auto& fn : funcNames) {
    if (fn == "fuse_transform") { sawTransform = true; continue; }
    renameIdent(funcs, fn, fn + sfx);
  }
  if (!sawTransform) return false;
  renameIdent(funcs, "fuse_transform", "ft_" + std::to_string(idx));
  renameIdent(cbuf, "type_ConstantBuffer_FuseUniforms", "FU_" + std::to_string(idx));
  // Each stage's uniform buffer binds at slot 2 + idx (sketch_executor.cpp).
  const std::string reg = "register(b" + std::to_string(2 + idx) + ")";
  size_t at = cbuf.find("register(b");
  if (at == std::string::npos) return false;
  size_t close = cbuf.find(')', at);
  if (close == std::string::npos) return false;
  cbuf.replace(at, close + 1 - at, reg);

  *cbufOut = std::move(cbuf);
  *funcsOut = std::move(funcs);
  return true;
}

}  // namespace

std::string generateFusedHLSL(const std::vector<std::string>& pixelHLSLs) {
  if (pixelHLSLs.empty()) return "";
  std::string cbuffers, functions;
  for (size_t i = 0; i < pixelHLSLs.size(); ++i) {
    std::string cb, fn;
    if (!rewriteStageHLSL(pixelHLSLs[i], (int)i, &cb, &fn)) return "";
    cbuffers += cb + "\n\n";
    functions += fn;
  }

  std::string out;
  out.reserve(cbuffers.size() + functions.size() + 1024);
  out += "Texture2D<float4>   tex_in  : register(t0);\n";
  out += "RWTexture2D<float4> tex_out : register(u1);\n\n";
  out += cbuffers;
  out += functions;
  // `fused_main` is OUR name in OUR HLSL, so unlike a spirv-cross entry (always
  // `main`) it survives to FXC — which is what the executor asks for.
  out += "[numthreads(8, 8, 1)]\n";
  out += "void fused_main(uint3 gid_in : SV_DispatchThreadID)\n";
  out += "{\n";
  out += "  uint W, H;\n";
  out += "  tex_out.GetDimensions(W, H);\n";
  out += "  uint2 gid = gid_in.xy;\n";
  out += "  if (gid.x >= W || gid.y >= H) return;\n";
  out += "  float4 c = tex_in.Load(int3(int2(gid), 0));\n";
  for (size_t i = 0; i < pixelHLSLs.size(); ++i) {
    char line[64];
    std::snprintf(line, sizeof(line), "  c = ft_%zu(gid, c);\n", i);
    out += line;
  }
  out += "  tex_out[gid] = c;\n";
  out += "}\n";
  return out;
}

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
