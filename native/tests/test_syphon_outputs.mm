// test_syphon_outputs.mm — a display output's Syphon server, end to end in
// one process: SyphonOutputs (the compositor's servers) publishes a frame, a
// Syphon client (the vendored client core) connects by the server's
// description, receives it, and reads the pixels out of the shared IOSurface.
// Also: a resize hands out a new surface, and the server's name follows the
// slot's. Compiled under ARC.

#include <catch2/catch_test_macros.hpp>

#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>

#include <atomic>
#include <chrono>
#include <memory>

#include "compositor/syphon_outputs.h"

#import "SyphonClientBase.h"
#import "SyphonServerBase.h"
#import "SyphonSubclassing.h"
#import "SyphonPrivate.h"

namespace {

/// Fill a BGRA IOSurface with one colour (what the GPU blit does in the app).
void fill(IOSurfaceRef s, uint8_t b, uint8_t g, uint8_t r) {
  IOSurfaceLock(s, 0, nullptr);
  auto* base = (uint8_t*)IOSurfaceGetBaseAddress(s);
  const size_t stride = IOSurfaceGetBytesPerRow(s);
  for (size_t y = 0; y < IOSurfaceGetHeight(s); y++) {
    for (size_t x = 0; x < IOSurfaceGetWidth(s); x++) {
      uint8_t* p = base + y * stride + x * 4;
      p[0] = b; p[1] = g; p[2] = r; p[3] = 255;
    }
  }
  IOSurfaceUnlock(s, 0, nullptr);
}

/// Spin the run loop until `done` or a timeout.
template <class F>
bool until(F done, double sec = 5.0) {
  const auto end = std::chrono::steady_clock::now() + std::chrono::duration<double>(sec);
  while (std::chrono::steady_clock::now() < end) {
    if (done()) return true;
    CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, true);
  }
  return done();
}

}  // namespace

TEST_CASE("syphon: a published frame reaches a client, pixel for pixel", "[syphon]") {
  compositor::SyphonOutputs outs(/*privateServers=*/true);  // no Syphon app lists it
  IOSurfaceRef surf = outs.ensure("d1", "Display 1", 32, 16);
  REQUIRE(surf);
  CHECK(IOSurfaceGetWidth(surf) == 32);
  CHECK(IOSurfaceGetHeight(surf) == 16);
  fill(surf, 0, 0, 255);  // red

  NSDictionary* desc = (__bridge NSDictionary*)outs.description("d1");
  REQUIRE(desc);
  CHECK([desc[SyphonServerDescriptionNameKey] isEqualToString:@"Display 1"]);

  auto frames = std::make_shared<std::atomic<int>>(0);
  SyphonClientBase* client = [[SyphonClientBase alloc] initWithServerDescription:desc options:nil
                                                                newFrameHandler:^(id) { (*frames)++; }];
  REQUIRE(client);
  REQUIRE(until([&] { return client.isValid; }));
  // Keep publishing until the client has one (connection is asynchronous).
  REQUIRE(until([&] {
    outs.publish("d1");
    return frames->load() > 0;
  }));
  IOSurfaceRef got = [client newSurface];
  REQUIRE(got);
  CHECK(IOSurfaceGetID(got) == IOSurfaceGetID(surf));
  IOSurfaceLock(got, kIOSurfaceLockReadOnly, nullptr);
  const uint8_t* px = (const uint8_t*)IOSurfaceGetBaseAddress(got) + 8 * IOSurfaceGetBytesPerRow(got) + 16 * 4;
  CHECK(px[2] == 255);
  CHECK(px[1] == 0);
  CHECK(px[0] == 0);
  IOSurfaceUnlock(got, kIOSurfaceLockReadOnly, nullptr);
  CFRelease(got);

  // Same size: the same surface. A new size: a new one, and clients follow.
  IOSurfaceRef same = outs.ensure("d1", "Display 1", 32, 16);
  CHECK(same == surf);
  CFRelease(same);
  IOSurfaceRef bigger = outs.ensure("d1", "Display 1", 64, 32);
  REQUIRE(bigger);
  CHECK(IOSurfaceGetWidth(bigger) == 64);
  fill(bigger, 0, 255, 0);
  const int before = frames->load();
  REQUIRE(until([&] {
    outs.publish("d1");
    return frames->load() > before;
  }));
  REQUIRE(until([&] {
    IOSurfaceRef g = [client newSurface];
    const bool ok = g && IOSurfaceGetWidth(g) == 64;
    if (g) CFRelease(g);
    return ok;
  }));

  [client stop];
  CFRelease(bigger);
  CFRelease(surf);
  outs.close("d1");
  CHECK_FALSE(outs.has("d1"));
}
