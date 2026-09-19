#pragma once

// ScopedPool — a drainable scope for the graphics API's per-frame temporaries.
//
// On Apple the Metal render path creates autoreleased objects every frame
// (MTLRenderPassDescriptor plus the command encoders and their AGX backing
// contexts). A plugin must NOT rely on its host draining a pool around each
// render: Resolume's render thread isn't guaranteed to, and ffgl_runner's serve
// loop runs thousands of frames inside one outer pool — so without a pool of
// our own those objects pile up unbounded (~5/frame → a steady multi-MB/min
// heap climb, which is what the soak test caught). Everywhere else this is an
// empty object the optimizer deletes.
//
// It exists as an RAII type rather than `@autoreleasepool` so the code that
// needs it can be plain C++ and compile for Windows too.

namespace nano_platform {

#ifdef __APPLE__

// The runtime entry points `@autoreleasepool` lowers to. Declared here rather
// than included from <objc/objc.h> so this header stays usable from a .cpp.
extern "C" void* objc_autoreleasePoolPush(void);
extern "C" void objc_autoreleasePoolPop(void* token);

class ScopedPool {
 public:
  ScopedPool() : token_(objc_autoreleasePoolPush()) {}
  ~ScopedPool() { objc_autoreleasePoolPop(token_); }
  ScopedPool(const ScopedPool&) = delete;
  ScopedPool& operator=(const ScopedPool&) = delete;

 private:
  void* token_;
};

#else

class ScopedPool {
 public:
  ScopedPool() = default;
  ScopedPool(const ScopedPool&) = delete;
  ScopedPool& operator=(const ScopedPool&) = delete;
};

#endif

}  // namespace nano_platform
