// streaky_blobs_plugin.mm — nano.StreakyBlobs FFGL bundle.
//
// Fixed-routing soft_glow → motion_blur pipeline running through the
// no-WASM effect_runtime + Metal GPUBackend. Effects link in
// statically; no WASM, no bridge dylib.
//
// FFGL hosts (Resolume) hand us an OpenGL texture per frame; we
// shuttle it to/from Metal via the CVPixelBuffer-backed InteropTexture
// borrowed from nano-ffglify, render via the effect runtime, and blit
// the result back.
//
// Adapted from /Users/nattos/Code/nano-ffglify/src/metal/ffgl-plugin.mm
// — the native_gl helper namespace, ScopedFBO/Shader/Texture/Sampler
// guards, GLShader / GLQuad, and the V-flipped blit shaders are
// substantially the same. What's swapped: the `func_main(EvalContext)`
// render hook → our two-effect pipeline; the parameter machinery →
// effect schema dispatch (deferred to a follow-up; constructor wires
// zero params for v1).

#include <array>
#include <cmath>
#include <dlfcn.h>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#import "InteropTexture.h"

#include <ffgl/FFGLPluginSDK.h>
#include <ffgl/FFGLPluginInfo.h>
#include <ffgl/FFGLLib.h>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"

// Effect entry points — class-like instance ABI (see EFFECTS_STYLE_GUIDE §0).
#define DECLARE_EFFECT_NS(ns)                                                 \
  namespace ns {                                                              \
    extern void  module_init();                                               \
    extern void* create();                                                    \
    extern void  destroy(void* self);                                         \
    extern void  init(void* self);                                            \
    extern void  tick(void* self, double dt);                                 \
    extern void  render(void* self, int vp_w, int vp_h);                      \
    extern void  on_state_patched(void* self, int n, const char* pb,          \
                                  const int* off, const int* len,             \
                                  const int* ops);                            \
    extern void  on_resolume_param(void* self, long long param_id, double v); \
  }
DECLARE_EFFECT_NS(soft_glow)
DECLARE_EFFECT_NS(motion_blur)
#undef DECLARE_EFFECT_NS

namespace effect_runtime {
  void setHostTime(double t);
  void setHostDeltaTime(double dt);
  void setHostBarPhase(double p);
  void setHostBpm(double bpm);
  void setHostViewport(int w, int h);
}

#include "soft_glow_msl.h"
#include "motion_blur_msl.h"

// ============================================================================
// native_gl — small GL helper namespace lifted (with light edits)
// from nano-ffglify/src/metal/ffgl-plugin.mm. Provides scoped GL state
// guards, a minimal GLShader compile helper, and a screen-aligned
// quad for blit operations.
// ============================================================================

namespace native_gl {

typedef void (*GenVertexArraysPtr)(GLsizei, GLuint *);
typedef void (*BindVertexArrayPtr)(GLuint);
typedef void (*DeleteVertexArraysPtr)(GLsizei, const GLuint *);
typedef void (*EnableVertexAttribArrayPtr)(GLuint);
typedef void (*VertexAttribPointerPtr)(GLuint, GLint, GLenum, GLboolean,
                                        GLsizei, const GLvoid *);

static GenVertexArraysPtr glGenVertexArraysFunc = nullptr;
static BindVertexArrayPtr glBindVertexArrayFunc = nullptr;
static DeleteVertexArraysPtr glDeleteVertexArraysFunc = nullptr;
static EnableVertexAttribArrayPtr glEnableVertexAttribArrayFunc = nullptr;
static VertexAttribPointerPtr glVertexAttribPointerFunc = nullptr;

static void InitGLFuncs() {
  if (!glGenVertexArraysFunc)
    glGenVertexArraysFunc = (GenVertexArraysPtr)dlsym(RTLD_DEFAULT, "glGenVertexArrays");
  if (!glGenVertexArraysFunc)
    glGenVertexArraysFunc = (GenVertexArraysPtr)dlsym(RTLD_DEFAULT, "glGenVertexArraysAPPLE");
  if (!glBindVertexArrayFunc)
    glBindVertexArrayFunc = (BindVertexArrayPtr)dlsym(RTLD_DEFAULT, "glBindVertexArray");
  if (!glBindVertexArrayFunc)
    glBindVertexArrayFunc = (BindVertexArrayPtr)dlsym(RTLD_DEFAULT, "glBindVertexArrayAPPLE");
  if (!glDeleteVertexArraysFunc)
    glDeleteVertexArraysFunc = (DeleteVertexArraysPtr)dlsym(RTLD_DEFAULT, "glDeleteVertexArrays");
  if (!glDeleteVertexArraysFunc)
    glDeleteVertexArraysFunc = (DeleteVertexArraysPtr)dlsym(RTLD_DEFAULT, "glDeleteVertexArraysAPPLE");
  if (!glEnableVertexAttribArrayFunc)
    glEnableVertexAttribArrayFunc = (EnableVertexAttribArrayPtr)dlsym(
        RTLD_DEFAULT, "glEnableVertexAttribArray");
  if (!glVertexAttribPointerFunc)
    glVertexAttribPointerFunc = (VertexAttribPointerPtr)dlsym(
        RTLD_DEFAULT, "glVertexAttribPointer");
}

struct ScopedFBO {
  GLint original = 0;
  ScopedFBO() { glGetIntegerv(GL_FRAMEBUFFER_BINDING, &original); }
  ScopedFBO(GLuint fbo) : ScopedFBO() { glBindFramebuffer(GL_FRAMEBUFFER, fbo); }
  ~ScopedFBO() { glBindFramebuffer(GL_FRAMEBUFFER, (GLuint)original); }
};
struct ScopedShader {
  GLint original = 0;
  ScopedShader() { glGetIntegerv(GL_CURRENT_PROGRAM, &original); }
  ScopedShader(GLuint program) : ScopedShader() { glUseProgram(program); }
  ~ScopedShader() { glUseProgram((GLuint)original); }
};
struct ScopedTexture {
  GLenum target;
  GLint original = 0;
  ScopedTexture(GLenum t, GLuint tex) : target(t) {
    if (t == GL_TEXTURE_2D) glGetIntegerv(GL_TEXTURE_BINDING_2D, &original);
    else                    glGetIntegerv(GL_TEXTURE_BINDING_RECTANGLE, &original);
    glBindTexture(t, tex);
  }
  ~ScopedTexture() { glBindTexture(target, (GLuint)original); }
};
struct ScopedSampler {
  GLint active = 0;
  ScopedSampler(int unit) {
    glGetIntegerv(GL_ACTIVE_TEXTURE, &active);
    glActiveTexture(GL_TEXTURE0 + unit);
  }
  ~ScopedSampler() { glActiveTexture((GLenum)active); }
};

class GLShader {
 public:
  GLuint program = 0;
  bool Compile(const char* vs, const char* fs) {
    GLuint v = glCreateShader(GL_VERTEX_SHADER);
    glShaderSource(v, 1, &vs, nullptr);
    glCompileShader(v);
    GLuint f = glCreateShader(GL_FRAGMENT_SHADER);
    glShaderSource(f, 1, &fs, nullptr);
    glCompileShader(f);
    program = glCreateProgram();
    glAttachShader(program, v);
    glAttachShader(program, f);
    glBindAttribLocation(program, 0, "vPos");
    glBindAttribLocation(program, 1, "vTex");
    glLinkProgram(program);
    glDeleteShader(v);
    glDeleteShader(f);
    GLint status = GL_FALSE;
    glGetProgramiv(program, GL_LINK_STATUS, &status);
    return status == GL_TRUE;
  }
  void SetInt(const char* n, int v)   { glUniform1i(glGetUniformLocation(program, n), v); }
  void SetVec2(const char* n, float a, float b) {
    glUniform2f(glGetUniformLocation(program, n), a, b);
  }
  void Free() { if (program) { glDeleteProgram(program); program = 0; } }
};

class GLQuad {
  GLuint vao = 0, vbo = 0;
 public:
  void Initialise() {
    InitGLFuncs();
    // V coords flipped (0→1, 1→0): corrects the Metal↔OpenGL IOSurface
    // origin mismatch at the input blit. Output blit additionally
    // uses glBlitFramebuffer with a flipped Y region.
    float verts[] = { -1,-1, 0,1,  1,-1, 1,1,  1,1, 1,0,  -1,1, 0,0 };
    if (glGenVertexArraysFunc) glGenVertexArraysFunc(1, &vao);
    if (vao == 0) return;
    glGenBuffers(1, &vbo);
    if (glBindVertexArrayFunc) glBindVertexArrayFunc(vao);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof(verts), verts, GL_STATIC_DRAW);
    glEnableVertexAttribArrayFunc(0);
    glVertexAttribPointerFunc(0, 2, GL_FLOAT, GL_FALSE, 4*4, 0);
    glEnableVertexAttribArrayFunc(1);
    glVertexAttribPointerFunc(1, 2, GL_FLOAT, GL_FALSE, 4*4, (void*)8);
    if (glBindVertexArrayFunc) glBindVertexArrayFunc(0);
  }
  void Draw() {
    if (!vao) return;
    glBindVertexArrayFunc(vao);
    glDrawArrays(GL_TRIANGLE_FAN, 0, 4);
    glBindVertexArrayFunc(0);
  }
  void Free() {
    if (vao && glDeleteVertexArraysFunc) glDeleteVertexArraysFunc(1, &vao);
    if (vbo) glDeleteBuffers(1, &vbo);
    vao = vbo = 0;
  }
};

}  // namespace native_gl

// V-flipped blit shaders — vertex emits (vUV * MaxUV) so the
// fragment can sample the source texture at the host-given UV.
static const char kBlitFromRectVS[] = R"(#version 410 core
uniform vec2 MaxUV;
layout(location=0) in vec4 vPosition;
layout(location=1) in vec2 vUV;
out vec2 uv;
void main() { gl_Position = vPosition; uv = vUV * MaxUV; }
)";
static const char kBlitFromRectFS[] = R"(#version 410 core
uniform sampler2DRect InputTexture;
in vec2 uv;
out vec4 fragColor;
void main() { fragColor = texture(InputTexture, uv); }
)";
// (No separate Tex2D vertex shader — same VS as the Rect path.)
static const char kBlitFromTex2DFS[] = R"(#version 410 core
uniform sampler2D InputTexture;
in vec2 uv;
out vec4 fragColor;
void main() { fragColor = texture(InputTexture, uv); }
)";

static inline FFGLTexCoords MaxGLTexCoords2D(const FFGLTextureStruct& t) {
  FFGLTexCoords c;
  c.s = (GLfloat)t.Width  / (GLfloat)t.HardwareWidth;
  c.t = (GLfloat)t.Height / (GLfloat)t.HardwareHeight;
  return c;
}
static inline FFGLTexCoords MaxGLTexCoordsRect(const FFGLTextureStruct& t) {
  FFGLTexCoords c;
  c.s = (GLfloat)t.Width;
  c.t = (GLfloat)t.Height;
  return c;
}

// ============================================================================
// StreakyBlobsPlugin — the actual FFGL effect.
// ============================================================================

class StreakyBlobsPlugin : public CFFGLPlugin {
 public:
  StreakyBlobsPlugin() : CFFGLPlugin() {
    SetMinInputs(1);
    SetMaxInputs(1);
    _device = MTLCreateSystemDefaultDevice();

    // Set up the effect runtime + run effects' init() in the
    // CONSTRUCTOR, not InitGL — because FFGL hosts (Resolume) query
    // the parameter list on a *prototype* instance during plugin scan,
    // and that prototype never receives InitGL. SetParamInfo must be
    // called by the time the host walks the param list, which means
    // before the constructor returns.
    //
    // Metal device creation + compute PSO setup don't need a GL
    // context, so doing it here is safe. The actual GL-side resources
    // (blit shaders, GLQuad, InteropTextures) live in InitGL/Resize
    // where the host's GL context IS current.
    if (_device) initRuntimeAndRegisterParams();
  }

  void initRuntimeAndRegisterParams() {
    _gpu = gpu::createMetalBackend();
    if (!_gpu) return;
    _rt = std::make_unique<effect_runtime::EffectRuntime>(_gpu.get());

    // Register MSL shaders BEFORE registering effect types: registerEffect
    // runs the effect's module_init() synchronously, which compiles the
    // shared compute PSOs via createShaderModuleByName.
    _rt->registerShaderMSL("soft_glow_color",  SOFT_GLOW_COLOR_MSL);
    _rt->registerShaderMSL("soft_glow_motion", SOFT_GLOW_MOTION_MSL);
    _rt->registerShaderMSL("reconstruct",      MOTION_BLUR_RECONSTRUCT_MSL);
    _rt->registerShaderMSL("pyramid_reduce",   MOTION_BLUR_PYRAMID_REDUCE_MSL);

    {
      effect_runtime::EffectDesc d;
      d.id = "gen.soft_glow";
      d.name = "Soft Glow";
      d.module_init      = &soft_glow::module_init;
      d.create           = &soft_glow::create;
      d.destroy          = &soft_glow::destroy;
      d.init             = &soft_glow::init;
      d.tick             = &soft_glow::tick;
      d.render           = &soft_glow::render;
      d.on_state_patched = &soft_glow::on_state_patched;
      d.on_resolume_param = &soft_glow::on_resolume_param;
      _rt->registerEffect(d);   // registers the type + runs module_init()

      d = {};
      d.id = "video.motion_blur";
      d.name = "Motion Blur";
      d.module_init      = &motion_blur::module_init;
      d.create           = &motion_blur::create;
      d.destroy          = &motion_blur::destroy;
      d.init             = &motion_blur::init;
      d.tick             = &motion_blur::tick;
      d.render           = &motion_blur::render;
      d.on_state_patched = &motion_blur::on_state_patched;
      d.on_resolume_param = &motion_blur::on_resolume_param;
      _rt->registerEffect(d);
    }

    // One render instance of each (StreakyBlobs is a fixed 2-stage chain).
    // instanceFor lazily runs create() + init(self) for the keyed instance.
    _glowInst = _rt->instanceFor("gen.soft_glow", "glow");
    _blurInst = _rt->instanceFor("video.motion_blur", "blur");
    _rt->drainConsoleLog();

    // Mark soft_glow's render_outputs as connected so its motion pass
    // actually runs (the early-exit in soft_glow.render() checks
    // isOutputConnected("render_outputs")).
    _glowInst->setFieldConnected("render_outputs", false, true);
    _blurInst->setFieldConnected("render_outputs", true, false);

    // Walk the schemas → SetParamInfo for each scalar field. Glow
    // params take the schema name verbatim (intensity, hue, …); blur
    // params keep a "Blur " prefix so the two motion_blur-specific
    // sliders (strength, samples, …) don't visually collide with
    // soft_glow's motion_strength / motion_skew etc.
    registerEffectParams(_glowInst, _rt->find("gen.soft_glow"), "");
    registerEffectParams(_blurInst, _rt->find("video.motion_blur"), "Blur ");
  }

  FFResult InitGL(const FFGLViewportStruct* vp) override {
    _currentViewport = *vp;
    _blitRect.Compile(kBlitFromRectVS, kBlitFromRectFS);
    _blit2D.Compile(kBlitFromRectVS, kBlitFromTex2DFS);
    _quad.Initialise();
    return _gpu ? CFFGLPlugin::InitGL(vp) : FF_FAIL;
  }

  FFResult DeInitGL() override {
    _blitRect.Free();
    _blit2D.Free();
    _quad.Free();
    _inputInterop.reset();
    _outputInterop.reset();
    // Keep _rt + _gpu + effect instances alive across DeInitGL/InitGL
    // cycles — they're not tied to the GL context. Resolume sometimes
    // tears down GL state mid-session (e.g. on resize / device switch)
    // and re-runs InitGL without destroying the plugin instance; if we
    // tore _rt down here, we'd lose the registered effects + their
    // file-static PSOs and have to recreate them all over again.
    return FF_SUCCESS;
  }

  FFResult Resize(const FFGLViewportStruct* vp) override {
    _currentViewport = *vp;
    return CFFGLPlugin::Resize(vp);
  }

  FFResult ProcessOpenGL(ProcessOpenGLStruct* pGL) override {
    if (pGL->numInputTextures < 1) return FF_SUCCESS;
    const unsigned int W = _currentViewport.width;
    const unsigned int H = _currentViewport.height;
    if (W == 0 || H == 0) return FF_SUCCESS;

    // Dispatch any host-side parameter changes into the effects'
    // on_state_patched callbacks before we render the new frame.
    flushDirtyParams();

    // Reallocate interop textures + intermediates on viewport change.
    if (!_outputInterop || _outputInterop->getWidth() != (int)W ||
        _outputInterop->getHeight() != (int)H) {
      _outputInterop = std::make_unique<InteropTexture>(
          _device, [NSOpenGLContext currentContext], true,
          MTLPixelFormatBGRA8Unorm, (int)W, (int)H);
      // Intermediates are owned by us, but exposed to effects via
      // textureFields. Allocate via the backend so the runtime sees
      // matching handles when effects call textureForField.
      if (_intermediateColor > 0) _gpu->release(_intermediateColor);
      if (_glowMotionTex     > 0) _gpu->release(_glowMotionTex);
      _intermediateColor = _gpu->createTexture(W, H, /*RGBA8*/ 1);
      _glowMotionTex     = _gpu->createTexture(W, H, /*RGBA16F*/ 3);
    }

    // ---- 1. Blit host input texture → input InteropTexture ----
    const auto* pInput = pGL->inputTextures[0];
    if (!_inputInterop || _inputInterop->getWidth() != (int)pInput->Width ||
        _inputInterop->getHeight() != (int)pInput->Height) {
      _inputInterop = std::make_unique<InteropTexture>(
          _device, [NSOpenGLContext currentContext], true,
          MTLPixelFormatBGRA8Unorm, (int)pInput->Width, (int)pInput->Height);
    }
    glBindFramebuffer(GL_FRAMEBUFFER, pGL->HostFBO);
    glDisable(GL_DEPTH_TEST);
    glDisable(GL_CULL_FACE);
    glDisable(GL_BLEND);
    glDisable(GL_SCISSOR_TEST);
    glDisable(GL_STENCIL_TEST);
    glDepthMask(GL_FALSE);
    {
      GLenum target = GL_TEXTURE_RECTANGLE;
      if (pInput->HardwareWidth > pInput->Width ||
          pInput->HardwareHeight > pInput->Height) {
        target = GL_TEXTURE_2D;
      }
      auto& shader = (target == GL_TEXTURE_2D) ? _blit2D : _blitRect;

      native_gl::ScopedFBO fbo(_inputInterop->getOpenGLFBO());
      native_gl::ScopedShader sh(shader.program);
      native_gl::ScopedSampler samp(0);
      native_gl::ScopedTexture tx(target, pInput->Handle);
      glTexParameteri(target, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
      glTexParameteri(target, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
      shader.SetInt("InputTexture", 0);
      FFGLTexCoords mc = (target == GL_TEXTURE_2D)
          ? MaxGLTexCoords2D(*pInput)
          : MaxGLTexCoordsRect(*pInput);
      shader.SetVec2("MaxUV", mc.s, mc.t);
      _quad.Draw();
    }
    glFlush();

    // ---- 2. Bridge interop textures into the runtime by handle ----
    // Zero-copy: adopt the interop's id<MTLTexture> directly. Effects
    // read/write through the SAME pixels the GL side sees. The handle
    // is freshly allocated each frame; the underlying MTLTexture lives
    // in the InteropTexture for the viewport's lifetime.
    int32_t inputMtlHandle  = _gpu->adoptExternalTexture(
        (__bridge void*)_inputInterop->getMetalTexture());
    int32_t outputMtlHandle = _gpu->adoptExternalTexture(
        (__bridge void*)_outputInterop->getMetalTexture());

    // DEBUG step 6: render soft_glow into a regular RGBA8 backend
    // texture (the intermediate), then COPY that result into the
    // adopted BGRA8 InteropTexture. Tests whether the soft_glow
    // render path actually produces pixels — independent of whether
    // the IOSurface-backed BGRA8 destination accepts compute-shader
    // writes from a complex multi-binding PSO.
    //
    // If glow visible → soft_glow renders fine to an RGBA8 backend
    // texture, but writing directly to the BGRA8 InteropTexture is
    // the broken case. Fix would be either: render to intermediate
    // and copy each frame (one extra blit, still fast); OR figure
    // out why BGRA8 IOSurface writes fail for this specific shader.
    //
    // If still black → soft_glow's render itself never wrote to the
    // intermediate texture either (PSO creation failed, dispatch
    // didn't run, or buffer/uniform binding is wrong).
    double hostT = hostTime / 1000.0;
    if (!_timeInitialized) {
      _startHostTime = hostT;
      _prevHostTime  = hostT;
      _timeInitialized = true;
    }
    double rawDt = hostT - _prevHostTime;
    double dt = std::max(0.0, std::min(rawDt, 0.1));
    _prevHostTime = hostT;
    effect_runtime::setHostTime(hostT - _startHostTime);
    effect_runtime::setHostDeltaTime(dt);
    effect_runtime::setHostViewport(W, H);

    // soft_glow writes directly into the adopted BGRA8 InteropTexture.
    // Metal's compute storage-texture write does channel-semantic
    // conversion (shader writes float4(r,g,b,a); Metal stores into
    // BGRA8 with R→mem[2], G→mem[1], B→mem[0]). The GL side then
    // reads semantic RGBA correctly.
    //
    // Earlier this path produced black, but that was because the
    // metal_backend's beginComputePass was orphaning the previous
    // pass's cmdBuffer on every begin(). Fixed in commit-pair with
    // the cmdBuffer reuse — now both color and motion passes commit
    // as one buffer at submit().
    // Pipeline: soft_glow renders into the intermediate (RGBA8),
    // also emitting motion vectors into a texture it allocates
    // internally (overwriting whatever we pre-set into
    // "render_outputs/motion"). Then motion_blur reads the
    // intermediate + bridged motion and writes the final streaks
    // into the adopted BGRA8 InteropTexture (which Metal handles
    // with channel-semantic conversion).
    _glowInst->setTextureField("tex_in", inputMtlHandle);
    _glowInst->setTextureField("tex_out", _intermediateColor);
    _glowInst->doTick(dt);
    _glowInst->doRender(W, H);

    // Bridge soft_glow's render_outputs/motion → motion_blur's input
    // of the same name. Each EffectInstance has its own textureFields
    // map; the rails plumbing that auto-bridges these in the dev IDE
    // is absent from the plugin (fixed routing).
    int glowMotion = _glowInst->textureField("render_outputs/motion");

    _blurInst->setTextureField("tex_in", _intermediateColor);
    _blurInst->setTextureField("tex_out", outputMtlHandle);
    _blurInst->setTextureField("render_outputs/motion", glowMotion);
    _blurInst->doTick(dt);
    _blurInst->doRender(W, H);

    _gpu->submit();
    _rt->drainConsoleLog();  // discard per-frame logs to keep host log clean

    // Release the per-frame adopted handles so the backend's resource
    // table doesn't grow without bound. The underlying MTLTextures
    // belong to the InteropTextures (no Metal teardown happens here).
    _gpu->release(inputMtlHandle);
    _gpu->release(outputMtlHandle);

    // ---- 5. Blit output InteropTexture → host FBO via glBlitFramebuffer
    {
      GLint prevRead = 0, prevDraw = 0;
      glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &prevRead);
      glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &prevDraw);
      glBindFramebuffer(GL_READ_FRAMEBUFFER, _outputInterop->getOpenGLFBO());
      glBindFramebuffer(GL_DRAW_FRAMEBUFFER, pGL->HostFBO);
      // Flipped Y: IOSurface origin is top-left (Metal), FBO expects
      // bottom-left (GL).
      glBlitFramebuffer(0, (GLint)H, (GLint)W, 0,
                        0, 0, (GLint)W, (GLint)H,
                        GL_COLOR_BUFFER_BIT, GL_NEAREST);
      glBindFramebuffer(GL_READ_FRAMEBUFFER, (GLuint)prevRead);
      glBindFramebuffer(GL_DRAW_FRAMEBUFFER, (GLuint)prevDraw);
    }
    return FF_SUCCESS;
  }

  FFResult SetFloatParameter(unsigned int idx, float val) override {
    if (idx < _ffglParams.size()) {
      _ffglParams[idx].currentValueNorm = val;
      _ffglParams[idx].dirty = true;
    }
    return FF_SUCCESS;
  }
  float GetFloatParameter(unsigned int idx) override {
    if (idx < _ffglParams.size()) return _ffglParams[idx].currentValueNorm;
    return 0.0f;
  }

 private:
  id<MTLDevice> _device = nil;
  std::unique_ptr<gpu::GPUBackend> _gpu;
  std::unique_ptr<effect_runtime::EffectRuntime> _rt;
  effect_runtime::EffectInstance* _glowInst = nullptr;
  effect_runtime::EffectInstance* _blurInst = nullptr;

  FFGLViewportStruct _currentViewport = {0, 0, 640, 480};
  std::unique_ptr<InteropTexture> _inputInterop;
  std::unique_ptr<InteropTexture> _outputInterop;
  int32_t _intermediateColor = -1;
  int32_t _glowMotionTex = -1;

  // Diagnostic inline compute kernel — lazily-built solid-color fill.
  int32_t _debugFillShader = -1;
  int32_t _debugFillPSO = -1;

  native_gl::GLShader _blitRect;
  native_gl::GLShader _blit2D;
  native_gl::GLQuad   _quad;

  double _startHostTime = 0;
  double _prevHostTime = 0;
  bool _timeInitialized = false;

  // --- FFGL parameter dispatch table ---
  // Built once after the effects' init() runs in InitGL — walks each
  // effect's schema JSON and registers an FFGL parameter per scalar /
  // int / bool field. Resolume drives SetFloatParameter(index, [0,1]);
  // we look up the spec, scale to the field's [min, max], dispatch
  // via the runtime's setParamFloat. Vec/color params are deferred
  // (none of the lights effects use vec/color params).
  enum class FieldType { Float, Int, Bool };
  struct ParamSpec {
    effect_runtime::EffectInstance* inst;
    std::string path;
    FieldType type;
    float minVal;
    float maxVal;
    float defaultVal;
    float currentValueNorm; // [0, 1] as Resolume sends it
    bool  dirty;
  };
  std::vector<ParamSpec> _ffglParams;

  static float scaleToField(const ParamSpec& s, float v01) {
    return s.minVal + std::max(0.0f, std::min(1.0f, v01)) * (s.maxVal - s.minVal);
  }
  static float normalizeForFFGL(const ParamSpec& s) {
    if (s.maxVal == s.minVal) return 0.5f;
    return (s.defaultVal - s.minVal) / (s.maxVal - s.minVal);
  }

  // `inst` is the render instance (setParamFloat target); `schemaInst` is the
  // type prototype that carries the published schema (module_init populates the
  // prototype, not the per-key render instance).
  void registerEffectParams(effect_runtime::EffectInstance* inst,
                             effect_runtime::EffectInstance* schemaInst,
                             const std::string& prefix) {
    if (!inst || !schemaInst) return;
    auto js = nlohmann::json::parse(schemaInst->schemaJson(), nullptr, false);
    if (js.is_discarded() || !js.contains("fields")) return;
    const auto& fields = js["fields"];
    if (!fields.is_object()) return;

    // Sort fields by their "order" key so the inspector arranges
    // them the way the effect author intended.
    std::vector<std::pair<int, std::string>> ordered;
    for (auto it = fields.begin(); it != fields.end(); ++it) {
      int order = it.value().value("order", 0);
      ordered.push_back({order, it.key()});
    }
    std::sort(ordered.begin(), ordered.end());

    for (const auto& kv : ordered) {
      const std::string& name = kv.second;
      const auto& f = fields[name];
      std::string ftype = f.value("type", std::string());
      ParamSpec spec{};
      spec.inst = inst;
      spec.path = name;
      spec.dirty = false;
      if (ftype == "float") {
        spec.type = FieldType::Float;
        spec.minVal = f.value("min", 0.0f);
        spec.maxVal = f.value("max", 1.0f);
        spec.defaultVal = f.value("default", 0.0f);
      } else if (ftype == "int") {
        spec.type = FieldType::Int;
        spec.minVal = (float)f.value("min", 0);
        spec.maxVal = (float)f.value("max", 1);
        spec.defaultVal = (float)f.value("default", 0);
      } else if (ftype == "bool") {
        spec.type = FieldType::Bool;
        spec.minVal = 0.0f;
        spec.maxVal = 1.0f;
        spec.defaultVal = f.value("default", false) ? 1.0f : 0.0f;
      } else {
        continue;  // texture / object / vec — deferred
      }
      spec.currentValueNorm = normalizeForFFGL(spec);
      std::string ffglName = prefix + name;
      unsigned int idx = (unsigned int)_ffglParams.size();
      _ffglParams.push_back(spec);
      if (spec.type == FieldType::Bool) {
        SetParamInfo(idx, ffglName.c_str(), FF_TYPE_BOOLEAN,
                     spec.defaultVal > 0.5f);
      } else {
        SetParamInfo(idx, ffglName.c_str(), FF_TYPE_STANDARD,
                     spec.currentValueNorm);
      }
    }
  }

  void flushDirtyParams() {
    for (auto& p : _ffglParams) {
      if (!p.dirty) continue;
      p.dirty = false;
      float v = scaleToField(p, p.currentValueNorm);
      if (p.type == FieldType::Int) v = std::round(v);
      else if (p.type == FieldType::Bool) v = (v >= 0.5f) ? 1.0f : 0.0f;
      p.inst->setParamFloat(p.path, v);
    }
  }
};

static CFFGLPluginInfo PluginInfo(
    PluginFactory<StreakyBlobsPlugin>,
    "NSBL",            // 4-char ID
    "nano.StreakyBlobs",
    2, 1,              // FFGL API
    1, 0,              // Plugin version
    FF_EFFECT,
    "Soft glow with motion-vector streaks",
    "nattos");
