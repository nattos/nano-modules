// ffgl_runner.mm — minimal host that loads an FFGL bundle via dlopen,
// drives `ProcessOpenGL` for N frames, reads back the result, and dumps
// it as a PNG. Lets me iterate on NanoBarrel (or any FFGL bundle here)
// without restarting Resolume each time.
//
// Adapted from /Users/nattos/Code/nano-ffglify/src/metal/ffgl-runner.mm
// — same shape; simplified output (PNG file instead of base64 JSON so
// it's easy to open from the terminal).

#import "../src/plugin/nano_barrel/InteropTexture.h"
#import <AppKit/AppKit.h>
#import <Cocoa/Cocoa.h>
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <dlfcn.h>
#include <ffgl/FFGL.h>
#include <ffgl/FFGLLib.h>

#include "../src/plugin/nano_barrel/barrel_codec.h"  // wrap a sketch JSON into the config param
#include <nlohmann/json.hpp>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#include <zlib.h>

#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <chrono>
#include <ctime>
#include <thread>

// Minimal send-only WebSocket client: connect, RFC6455 handshake, send ONE
// masked text frame, close. Lets ffgl_runner drive the plugin's own bridge over
// WS exactly as the web editor does — to repro barrel-mode-only bugs.
static bool ws_send_text(int port, const std::string& payload) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return false;
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons((uint16_t)port);
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
  if (connect(fd, (sockaddr*)&addr, sizeof(addr)) != 0) { close(fd); return false; }
  // Handshake (fixed RFC example key; we don't validate the accept).
  std::string req =
    "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n"
    "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    "Sec-WebSocket-Version: 13\r\n\r\n";
  if (write(fd, req.data(), req.size()) < 0) { close(fd); return false; }
  char buf[2048]; std::string resp;
  while (resp.find("\r\n\r\n") == std::string::npos) {
    ssize_t n = read(fd, buf, sizeof(buf));
    if (n <= 0) break;
    resp.append(buf, n);
  }
  // Build a masked client text frame (mask key = 0 → payload unchanged).
  std::vector<uint8_t> frame;
  frame.push_back(0x81);  // FIN + text
  size_t len = payload.size();
  if (len < 126) { frame.push_back(0x80 | (uint8_t)len); }
  else if (len < 65536) { frame.push_back(0x80 | 126); frame.push_back((len>>8)&0xff); frame.push_back(len&0xff); }
  else { frame.push_back(0x80 | 127); for (int i=7;i>=0;i--) frame.push_back((len>>(8*i))&0xff); }
  frame.insert(frame.end(), {0,0,0,0});  // zero mask key
  frame.insert(frame.end(), payload.begin(), payload.end());
  bool ok = write(fd, frame.data(), frame.size()) == (ssize_t)frame.size();
  std::this_thread::sleep_for(std::chrono::milliseconds(150));  // let the server apply
  close(fd);
  return ok;
}

// Send one WS text request and read back one text response frame (server
// frames are unmasked). Returns the response payload, or "" on failure.
// Used to discover the barrel instance key from /global/plugins now that the
// shared server multiplexes many instances under runtime-assigned UUID keys.
static std::string ws_request(int port, const std::string& payload) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return "";
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons((uint16_t)port);
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
  if (connect(fd, (sockaddr*)&addr, sizeof(addr)) != 0) { close(fd); return ""; }
  std::string req =
    "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n"
    "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    "Sec-WebSocket-Version: 13\r\n\r\n";
  if (write(fd, req.data(), req.size()) < 0) { close(fd); return ""; }
  char buf[4096]; std::string resp;
  while (resp.find("\r\n\r\n") == std::string::npos) {
    ssize_t n = read(fd, buf, sizeof(buf));
    if (n <= 0) { close(fd); return ""; }
    resp.append(buf, n);
  }
  // Send masked client text frame (zero mask).
  std::vector<uint8_t> frame;
  frame.push_back(0x81);
  size_t len = payload.size();
  if (len < 126) { frame.push_back(0x80 | (uint8_t)len); }
  else if (len < 65536) { frame.push_back(0x80 | 126); frame.push_back((len>>8)&0xff); frame.push_back(len&0xff); }
  else { frame.push_back(0x80 | 127); for (int i=7;i>=0;i--) frame.push_back((len>>(8*i))&0xff); }
  frame.insert(frame.end(), {0,0,0,0});
  frame.insert(frame.end(), payload.begin(), payload.end());
  if (write(fd, frame.data(), frame.size()) != (ssize_t)frame.size()) { close(fd); return ""; }
  // Read one server text frame (poll up to ~1s).
  std::string acc;
  for (int tries = 0; tries < 100; ++tries) {
    ssize_t n = read(fd, buf, sizeof(buf));
    if (n > 0) { acc.append(buf, n); }
    else { std::this_thread::sleep_for(std::chrono::milliseconds(10)); continue; }
    // Parse a single unmasked text frame from the front of acc.
    if (acc.size() < 2) continue;
    size_t pos = 2;
    uint64_t plen = (uint8_t)acc[1] & 0x7f;
    if (plen == 126) { if (acc.size() < 4) continue; plen = ((uint8_t)acc[2]<<8)|(uint8_t)acc[3]; pos = 4; }
    else if (plen == 127) { if (acc.size() < 10) continue; plen = 0; for (int i=0;i<8;i++) plen=(plen<<8)|(uint8_t)acc[2+i]; pos = 10; }
    if (acc.size() < pos + plen) continue;
    std::string out = acc.substr(pos, plen);
    close(fd);
    return out;
  }
  close(fd);
  return "";
}

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
    // --config <file>: read a sketch JSON file, wrap it the way NanoBarrel's
    // FILE config param expects (nanobarrel://config?<base64>), and set it on
    // text param 0 after instantiate so the barrel runs that sketch.
    std::string configWrapped;
    // --ws-patch <file>: after instantiate, push the sketch JSON over the
    // plugin's own WebSocket bridge as `replace /sketch` (exactly like the web
    // editor in barrel mode), to repro barrel-only bugs.
    std::string wsSketch;
    // --text IDX <string>: set an arbitrary text param verbatim.
    std::vector<std::pair<int, std::string>> textOverrides;
    int positional = 0;
    for (int i = 2; i < argc; ++i) {
      std::string arg = argv[i];
      if (arg == "--param" && i + 2 < argc) {
        int idx = std::stoi(argv[i + 1]);
        float val = std::stof(argv[i + 2]);
        paramOverrides.push_back({idx, val});
        i += 2;
      } else if (arg == "--config" && i + 1 < argc) {
        std::ifstream f(argv[i + 1], std::ios::binary);
        std::string json((std::istreambuf_iterator<char>(f)),
                         std::istreambuf_iterator<char>());
        configWrapped = barrel_codec::wrap_config(json);
        i += 1;
      } else if (arg == "--text" && i + 2 < argc) {
        textOverrides.push_back({std::stoi(argv[i + 1]), argv[i + 2]});
        i += 2;
      } else if (arg == "--ws-patch" && i + 1 < argc) {
        std::ifstream f(argv[i + 1], std::ios::binary);
        wsSketch.assign((std::istreambuf_iterator<char>(f)),
                        std::istreambuf_iterator<char>());
        i += 1;
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

    // Text-param overrides (FFGL routes FF_TYPE_TEXT/FILE to SetTextParameter
    // via NewParameterValue.PointerValue). The config (param 0) goes last so it
    // wins over any --text on the same index.
    for (auto& [idx, str] : textOverrides) {
      SetParameterStruct sps;
      sps.ParameterNumber = (FFUInt32)idx;
      sps.NewParameterValue.PointerValue = (void*)str.c_str();
      plugMain(FF_SET_PARAMETER, (FFMixed){.PointerValue = &sps}, instanceID);
      std::cerr << "[ffgl_runner] text param[" << idx << "] set (" << str.size() << " bytes)\n";
    }
    if (!configWrapped.empty()) {
      SetParameterStruct sps;
      sps.ParameterNumber = 0;  // P_CONFIG
      sps.NewParameterValue.PointerValue = (void*)configWrapped.c_str();
      plugMain(FF_SET_PARAMETER, (FFMixed){.PointerValue = &sps}, instanceID);
      std::cerr << "[ffgl_runner] config set (" << configWrapped.size() << " bytes wrapped)\n";
    }

    // Barrel WS path: push the sketch over the shared server like the editor.
    // The shared server listens on the fixed port 8081 and multiplexes every
    // instance under a runtime-assigned UUID key — so discover this instance's
    // key from /global/plugins rather than assuming the old "@0" form.
    if (!wsSketch.empty()) {
      constexpr int kPort = 8081;
      std::string key;
      for (int tries = 0; tries < 50 && key.empty(); ++tries) {
        std::string snap = ws_request(kPort, R"({"action":"get","path":"/global/plugins"})");
        auto j = nlohmann::json::parse(snap, nullptr, false);
        if (!j.is_discarded() && j.contains("data") && j["data"].is_array()) {
          for (auto& p : j["data"]) {
            if (p.value("key", std::string()).empty()) continue;
            if (p.contains("metadata") &&
                p["metadata"].value("id", std::string()) == "com.nano.nanobarrel") {
              key = p["key"].get<std::string>();
              break;
            }
          }
        }
        if (key.empty()) std::this_thread::sleep_for(std::chrono::milliseconds(20));
      }
      std::string msg =
        "{\"action\":\"patch\",\"target\":\"/plugins/" + key + "/state\","
        "\"ops\":[{\"op\":\"replace\",\"path\":\"/sketch\",\"value\":" + wsSketch + "}]}";
      bool ok = !key.empty() && ws_send_text(kPort, msg);
      std::cerr << "[ffgl_runner] ws-patch key=" << key << " sent=" << ok << "\n";
    }

    // 4. Host FBO for the plugin to render INTO. Use an IOSurface-backed
    // InteropTexture (createOpenGLFBO=true) rather than a plain GL texture, so
    // the host's output surface is shared between OpenGL and Metal — exactly the
    // shape Resolume hands us. That makes ffgl_runner a faithful test bed for the
    // plugin adopting the host surface directly (skipping the GL↔Metal blit):
    // both the input AND output it sees are now IOSurface-backed.
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    auto outputInterop = std::make_unique<InteropTexture>(
        device, context, /*createOpenGLFBO=*/ true,
        MTLPixelFormatBGRA8Unorm, width, height);
    GLuint fbo = outputInterop->getOpenGLFBO();
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
      std::cerr << "host FBO (interop) incomplete\n"; return 1;
    }
    glClearColor(0, 0, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);

    // 5. One InteropTexture as the plugin's input (also IOSurface-backed) —
    // filled with a horizontal red gradient so we can tell input handoff apart
    // from pure-output cases.
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
    //
    // Benchmark with THREAD-CPU time (CLOCK_THREAD_CPUTIME_ID), not wall: the
    // FFGL GL↔Metal interop blocks the render thread on GPU completion every
    // frame (resolution-independent), so wall time is GPU-wait-dominated and
    // useless for CPU-side work. Thread-CPU excludes those blocks, so it
    // isolates ProcessOpenGL's actual CPU cost (the executor walk, encode, etc.).
    double dt_ms = 1000.0 / 60.0;
    timespec cpu0{}, cpu1{};
    clock_gettime(CLOCK_THREAD_CPUTIME_ID, &cpu0);
    for (int f = 0; f < numFrames; ++f) {
      double t = f * dt_ms;
      plugMain(FF_SET_TIME, (FFMixed){.PointerValue = &t}, instanceID);
      plugMain(FF_PROCESS_OPENGL,
               (FFMixed){.PointerValue = &ps}, instanceID);
      glFlush();
    }
    clock_gettime(CLOCK_THREAD_CPUTIME_ID, &cpu1);
    double cpuMs = (cpu1.tv_sec - cpu0.tv_sec) * 1e3 +
                   (cpu1.tv_nsec - cpu0.tv_nsec) / 1e6;
    std::cerr << "[ffgl_runner] processed " << numFrames << " frames; "
              << "ProcessOpenGL thread-CPU " << cpuMs << " ms total, "
              << (cpuMs / numFrames) << " ms/frame\n";

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

    // 8. Cleanup. (fbo + its color texture are owned by outputInterop.)
    plugMain(FF_DEINSTANTIATE_GL, (FFMixed){.PointerValue = nullptr},
             instanceID);
    plugMain(FF_DEINITIALISE, (FFMixed){.PointerValue = nullptr}, 0);
    dlclose(handle);
  }
  return 0;
}
