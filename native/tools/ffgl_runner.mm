// ffgl_runner.mm — minimal host that loads an FFGL bundle via dlopen,
// drives `ProcessOpenGL` for N frames, reads back the result, and dumps
// it as a PNG. Lets me iterate on StreakyBlobs (or any FFGL bundle here)
// without restarting Resolume each time.
//
// Adapted from /Users/nattos/Code/nano-ffglify/src/metal/ffgl-runner.mm
// — same shape; simplified output (PNG file instead of base64 JSON so
// it's easy to open from the terminal).

#import "../src/plugin/streaky_blobs/InteropTexture.h"
#import <AppKit/AppKit.h>
#import <Cocoa/Cocoa.h>
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <dlfcn.h>
#include <ffgl/FFGL.h>
#include <ffgl/FFGLLib.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#include <zlib.h>

typedef FFMixed (*FFGLPluginMainPtr)(FFUInt32, FFMixed, FFInstanceID);

// --- Minimal PNG encoder (lifted from web/test/gpu-test-helpers.ts pattern) ---
static uint32_t crc32_of(const uint8_t* buf, size_t len) {
  uint32_t c = 0xFFFFFFFF;
  for (size_t i = 0; i < len; ++i) {
    c ^= buf[i];
    for (int j = 0; j < 8; ++j) c = (c >> 1) ^ ((c & 1) ? 0xEDB88320u : 0u);
  }
  return c ^ 0xFFFFFFFFu;
}
static void write_be_u32(std::vector<uint8_t>& v, uint32_t x) {
  v.push_back((x >> 24) & 0xff);
  v.push_back((x >> 16) & 0xff);
  v.push_back((x >> 8) & 0xff);
  v.push_back(x & 0xff);
}
static void png_chunk(std::vector<uint8_t>& out, const char* type,
                      const uint8_t* data, size_t len) {
  write_be_u32(out, (uint32_t)len);
  size_t start = out.size();
  out.push_back(type[0]); out.push_back(type[1]);
  out.push_back(type[2]); out.push_back(type[3]);
  out.insert(out.end(), data, data + len);
  uint32_t crc = crc32_of(out.data() + start, 4 + len);
  write_be_u32(out, crc);
}
static bool write_png(const char* path, const uint8_t* rgba, int w, int h) {
  // Raw scanlines: 1 filter byte + W*4 pixel bytes per row.
  std::vector<uint8_t> raw((size_t)h * (1 + w * 4));
  for (int y = 0; y < h; ++y) {
    raw[(size_t)y * (1 + w * 4)] = 0;
    memcpy(raw.data() + (size_t)y * (1 + w * 4) + 1,
           rgba + (size_t)y * w * 4, (size_t)w * 4);
  }
  // zlib deflate
  uLongf compLen = compressBound((uLong)raw.size());
  std::vector<uint8_t> comp(compLen);
  if (compress(comp.data(), &compLen, raw.data(), (uLong)raw.size()) != Z_OK) {
    return false;
  }
  comp.resize(compLen);

  std::vector<uint8_t> out;
  // Signature
  static const uint8_t sig[] = {137,80,78,71,13,10,26,10};
  out.insert(out.end(), sig, sig + 8);
  // IHDR
  std::vector<uint8_t> ihdr;
  write_be_u32(ihdr, (uint32_t)w);
  write_be_u32(ihdr, (uint32_t)h);
  ihdr.push_back(8);  // bit depth
  ihdr.push_back(6);  // color type (RGBA)
  ihdr.push_back(0); ihdr.push_back(0); ihdr.push_back(0);
  png_chunk(out, "IHDR", ihdr.data(), ihdr.size());
  // IDAT
  png_chunk(out, "IDAT", comp.data(), comp.size());
  // IEND
  png_chunk(out, "IEND", nullptr, 0);

  std::ofstream f(path, std::ios::binary);
  if (!f) return false;
  f.write((const char*)out.data(), (std::streamsize)out.size());
  return true;
}

int main(int argc, const char* argv[]) {
  @autoreleasepool {
    if (argc < 2) {
      std::cerr << "Usage: ffgl_runner <path-to-bundle> [width height] "
                   "[frames] [out.png]\n";
      return 1;
    }
    const char* bundlePath = argv[1];
    int width = 640;
    int height = 480;
    int numFrames = 60;
    const char* outPath = "/tmp/ffgl_runner_out.png";
    // --param IDX VALUE — set FFGL parameter IDX to VALUE in [0,1].
    // Repeatable. Parsed before positional args.
    std::vector<std::pair<int, float>> paramOverrides;
    int positional = 0;
    for (int i = 2; i < argc; ++i) {
      std::string arg = argv[i];
      if (arg == "--param" && i + 2 < argc) {
        int idx = std::stoi(argv[i + 1]);
        float val = std::stof(argv[i + 2]);
        paramOverrides.push_back({idx, val});
        i += 2;
      } else {
        switch (positional++) {
          case 0: width = std::stoi(arg); break;
          case 1: height = std::stoi(arg); break;
          case 2: numFrames = std::stoi(arg); break;
          case 3: outPath = argv[i]; break;
        }
      }
    }

    std::cerr << "[ffgl_runner] bundle=" << bundlePath
              << " size=" << width << "x" << height
              << " frames=" << numFrames
              << " out=" << outPath << "\n";

    // 1. GL context (Core Profile 3.2+)
    NSOpenGLPixelFormatAttribute attrs[] = {
      NSOpenGLPFAAccelerated,
      NSOpenGLPFAColorSize, 24,
      NSOpenGLPFAAlphaSize, 8,
      NSOpenGLPFADepthSize, 24,
      NSOpenGLPFAOpenGLProfile, NSOpenGLProfileVersion3_2Core,
      0
    };
    NSOpenGLPixelFormat* pixelFormat =
        [[NSOpenGLPixelFormat alloc] initWithAttributes:attrs];
    if (!pixelFormat) { std::cerr << "no NSOpenGLPixelFormat\n"; return 1; }
    NSOpenGLContext* context =
        [[NSOpenGLContext alloc] initWithFormat:pixelFormat shareContext:nil];
    [context makeCurrentContext];

    // 2. Load the bundle.
    NSString* bp = [NSString stringWithUTF8String:bundlePath];
    NSBundle* bundle = [NSBundle bundleWithPath:bp];
    if (!bundle || ![bundle load]) {
      std::cerr << "failed to load bundle: " << bundlePath << "\n";
      return 1;
    }
    void* handle = dlopen([[bundle executablePath] UTF8String],
                          RTLD_LAZY | RTLD_LOCAL);
    if (!handle) {
      std::cerr << "dlopen failed: " << dlerror() << "\n"; return 1;
    }
    FFGLPluginMainPtr plugMain =
        (FFGLPluginMainPtr)dlsym(handle, "plugMain");
    if (!plugMain) { std::cerr << "no plugMain\n"; return 1; }

    // 3. FF_INITIALISE_V2 + FF_INSTANTIATE_GL.
    if (plugMain(FF_INITIALISE_V2,
                 (FFMixed){.PointerValue = nullptr}, 0).UIntValue == FF_FAIL) {
      std::cerr << "FF_INITIALISE_V2 failed\n"; return 1;
    }
    FFGLViewportStruct vp = {0, 0, (FFUInt32)width, (FFUInt32)height};
    FFMixed r = plugMain(FF_INSTANTIATE_GL,
                          (FFMixed){.PointerValue = &vp}, 0);
    if (r.UIntValue == FF_FAIL) {
      std::cerr << "FF_INSTANTIATE_GL failed\n"; return 1;
    }
    FFInstanceID instanceID = (FFInstanceID)r.PointerValue;
    plugMain(FF_RESIZE, (FFMixed){.PointerValue = &vp}, instanceID);

    // Dump the parameter list (prototype-queried; uses instanceID=0).
    FFUInt32 nparams = plugMain(FF_GET_NUM_PARAMETERS,
                                 (FFMixed){.PointerValue = nullptr}, 0).UIntValue;
    for (FFUInt32 i = 0; i < nparams; ++i) {
      const char* name = (const char*)plugMain(
          FF_GET_PARAMETER_NAME, (FFMixed){.UIntValue = i}, 0).PointerValue;
      FFUInt32 type = plugMain(FF_GET_PARAMETER_TYPE,
                                (FFMixed){.UIntValue = i}, 0).UIntValue;
      std::cerr << "[ffgl_runner] param[" << i << "] type=" << type
                << " name=" << (name ? name : "(null)") << "\n";
    }

    // Apply --param overrides via FF_SET_PARAMETER. FFGL packs floats
    // into FFMixed's UIntValue via bit-cast (see FFGL.cpp's
    // FF_SET_PARAMETER handler — it does *(float*)&UIntValue).
    for (auto [idx, val] : paramOverrides) {
      SetParameterStruct sps;
      sps.ParameterNumber = (FFUInt32)idx;
      uint32_t bits;
      std::memcpy(&bits, &val, sizeof(bits));
      sps.NewParameterValue.UIntValue = bits;
      plugMain(FF_SET_PARAMETER, (FFMixed){.PointerValue = &sps}, instanceID);
      std::cerr << "[ffgl_runner] param[" << idx << "] = " << val << "\n";
    }

    // 4. Host FBO + color attachment for the plugin to render INTO.
    GLuint fbo = 0, texColor = 0;
    glGenFramebuffers(1, &fbo);
    glGenTextures(1, &texColor);
    glBindTexture(GL_TEXTURE_2D, texColor);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0,
                 GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0,
                            GL_TEXTURE_2D, texColor, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
      std::cerr << "framebuffer incomplete\n"; return 1;
    }
    glClearColor(0, 0, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);

    // 5. One InteropTexture as the plugin's input — filled with a
    // horizontal red gradient so we can tell input handoff apart from
    // pure-output cases.
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    auto inputInterop = std::make_unique<InteropTexture>(
        device, context, /*createOpenGLFBO=*/ false,
        MTLPixelFormatBGRA8Unorm, width, height);
    glBindTexture(GL_TEXTURE_RECTANGLE, inputInterop->getOpenGLTexture());
    {
      std::vector<uint8_t> data((size_t)width * height * 4);
      for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
          size_t idx = (size_t)(y * width + x) * 4;
          data[idx + 0] = (uint8_t)((float)x / width * 255.0f);
          data[idx + 1] = 0;
          data[idx + 2] = 0;
          data[idx + 3] = 255;
        }
      }
      glTexSubImage2D(GL_TEXTURE_RECTANGLE, 0, 0, 0, width, height,
                       GL_RGBA, GL_UNSIGNED_BYTE, data.data());
    }

    FFGLTextureStruct inputStr;
    inputStr.Width = width;
    inputStr.Height = height;
    inputStr.HardwareWidth = width;
    inputStr.HardwareHeight = height;
    inputStr.Handle = inputInterop->getOpenGLTexture();
    FFGLTextureStruct* inputs[] = {&inputStr};

    ProcessOpenGLStruct ps;
    ps.numInputTextures = 1;
    ps.inputTextures = inputs;
    ps.HostFBO = fbo;

    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glViewport(0, 0, width, height);
    glFlush();  // ensure input write is visible to Metal

    // 6. Process N frames so timeline-driven effects (orbit phase
    // accumulators etc.) actually progress.
    double dt_ms = 1000.0 / 60.0;
    for (int f = 0; f < numFrames; ++f) {
      double t = f * dt_ms;
      plugMain(FF_SET_TIME, (FFMixed){.PointerValue = &t}, instanceID);
      plugMain(FF_PROCESS_OPENGL,
               (FFMixed){.PointerValue = &ps}, instanceID);
      glFlush();
    }
    std::cerr << "[ffgl_runner] processed " << numFrames << " frames\n";

    // 7. Readback host FBO → RGBA.
    std::vector<uint8_t> pixels((size_t)width * height * 4);
    glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());

    // Flip vertically — glReadPixels returns bottom-up; PNG expects top-down.
    {
      std::vector<uint8_t> flipped((size_t)width * height * 4);
      for (int y = 0; y < height; ++y) {
        memcpy(flipped.data() + (size_t)y * width * 4,
               pixels.data() + (size_t)(height - 1 - y) * width * 4,
               (size_t)width * 4);
      }
      pixels = std::move(flipped);
    }

    if (!write_png(outPath, pixels.data(), width, height)) {
      std::cerr << "failed to write " << outPath << "\n"; return 1;
    }
    std::cerr << "[ffgl_runner] wrote " << outPath << "\n";

    // 8. Cleanup.
    glDeleteTextures(1, &texColor);
    glDeleteFramebuffers(1, &fbo);
    plugMain(FF_DEINSTANTIATE_GL, (FFMixed){.PointerValue = nullptr},
             instanceID);
    plugMain(FF_DEINITIALISE, (FFMixed){.PointerValue = nullptr}, 0);
    dlclose(handle);
  }
  return 0;
}
