/*
 * text_effect_smoke.mm — runtime smoke test for the gen.text / gen.richtext
 * effects mapped into the native bundle. Mirrors NanoBarrel's initEffectRuntime:
 * builds a Metal-backed EffectRuntime, installs fonts via the Core Text provider,
 * registers the two effects (running their module_init), then drives each one's
 * render() through the runtime into a surface and asserts the output is non-blank.
 *
 * This exercises the path that only runs at plugin time (registration +
 * module_init + Core Text font install + effect render → text.* host impls),
 * which a compile/link check can't catch. Pixel-parity itself is covered by
 * text_host_parity.sh; here we just prove the wired effects actually run.
 */

#import <Metal/Metal.h>
#import <Foundation/Foundation.h>

#include "runtime/effect_runtime.h"
#include "runtime/text_host.h"
#include "gpu/gpu_backend.h"

#include <cstdio>
#include <cstdint>
#include <string>
#include <vector>

#define DECLARE_EFFECT_NS(ns)                                                 \
  namespace ns {                                                              \
    void  module_init();                                                      \
    void* create();                                                           \
    void  destroy(void* self);                                                \
    void  init(void* self);                                                   \
    void  tick(void* self, double dt);                                        \
    void  render(void* self, int vp_w, int vp_h);                             \
    void  on_state_patched(void* self, int n, const char* pb,                 \
                           const int* off, const int* len, const int* ops);   \
  }
DECLARE_EFFECT_NS(gen_text)
DECLARE_EFFECT_NS(gen_richtext)
#undef DECLARE_EFFECT_NS

using namespace effect_runtime;

static effect_runtime::EffectDesc descFor(
    const std::string& id, const std::string& name,
    void (*mi)(), void* (*cr)(), void (*ds)(void*), void (*in)(void*),
    void (*tk)(void*, double), void (*rn)(void*, int, int),
    void (*osp)(void*, int, const char*, const int*, const int*, const int*)) {
  effect_runtime::EffectDesc d;
  d.id = id; d.name = name;
  d.module_init = mi; d.create = cr; d.destroy = ds; d.init = in;
  d.tick = tk; d.render = rn; d.on_state_patched = osp;
  return d;
}

// Count pixels that aren't opaque black — i.e. something got drawn.
static long nonBlack(const std::vector<uint8_t>& img) {
  long n = 0;
  for (size_t i = 0; i + 3 < img.size(); i += 4)
    if (img[i] || img[i + 1] || img[i + 2]) n++;
  return n;
}

int main() {
  @autoreleasepool {
    const int W = 800, H = 600;
    auto backend = gpu::createMetalBackend();
    if (!backend) { std::fprintf(stderr, "no Metal backend\n"); return 1; }
    effect_runtime::EffectRuntime rt(backend.get());
    int surface = backend->createTexture(W, H, /*RGBA8*/1);
    backend->setSurface(surface, W, H);

    // Core Text provider: no bundled primary here → system UI font + CJK fallbacks.
    effect_runtime::textInstallDefaultFonts(nullptr);

    // module_init runs synchronously during registerEffect (publishes schema).
    rt.registerEffect(descFor("gen.text", "Text", &gen_text::module_init,
                              &gen_text::create, &gen_text::destroy, &gen_text::init,
                              &gen_text::tick, &gen_text::render,
                              &gen_text::on_state_patched));
    rt.registerEffect(descFor("gen.richtext", "Rich Text", &gen_richtext::module_init,
                              &gen_richtext::create, &gen_richtext::destroy,
                              &gen_richtext::init, &gen_richtext::tick,
                              &gen_richtext::render, &gen_richtext::on_state_patched));

    // What the barrel advertises over WS == proto->schemaJson() (ModuleRegistry
    // reads exactly this). Dump it so we can see whether the effect is published.
    for (const char* id : {"gen.text", "gen.richtext"}) {
      auto* proto = rt.find(id);
      std::string s = proto ? proto->schemaJson() : "(not registered)";
      std::printf("SCHEMA %s: %.200s%s\n", id, s.c_str(), s.size() > 200 ? " …" : "");
    }

    int rc = 0;
    struct Case { const char* type; const char* path; const char* json; };
    Case cases[] = {
      {"gen.text",     "text", "\"Smoke \xe6\x97\xa5\xe6\x9c\xac\""},          // Latin + CJK (fallback)
      {"gen.richtext", "html", "\"<h1 style='color:#fff;font-size:48px'>Hi</h1>\""},
    };
    for (const auto& c : cases) {
      auto* inst = rt.instanceFor(c.type, "k0");
      if (!inst) { std::fprintf(stderr, "instanceFor(%s) failed\n", c.type); rc = 1; continue; }
      inst->setParamJson(c.path, c.json);
      backend->clearTexture(surface, 0, 0, 0, 1);
      backend->submit();
      inst->doRender(W, H);          // the effect calls gpu::Device::submit() itself
      auto img = backend->readbackTexture(surface, W, H);
      long nb = nonBlack(img);
      std::printf("{\"effect\":\"%s\",\"nonBlackPx\":%ld}\n", c.type, nb);
      if (nb < 50) {                 // expect real glyph coverage
        std::fprintf(stderr, "❌ %s rendered (near-)blank\n", c.type); rc = 1;
      } else {
        std::fprintf(stderr, "✅ %s rendered through the native runtime\n", c.type);
      }
    }
    return rc;
  }
}
