#pragma once

// Conditional mutex primitives.
// Under BRIDGE_SINGLE_THREADED (WASM builds), all locks are no-ops.

#ifdef BRIDGE_SINGLE_THREADED

namespace bridge {
namespace platform {

struct NullMutex {
  void lock() {}
  void unlock() {}
  void lock_shared() {}
  void unlock_shared() {}
};

using Mutex = NullMutex;
using SharedMutex = NullMutex;

template<typename M>
struct LockGuard {
  explicit LockGuard(M&) {}
};

template<typename M>
struct UniqueLock {
  explicit UniqueLock(M&) {}
};

template<typename M>
struct SharedLock {
  explicit SharedLock(M&) {}
};

} // namespace platform
} // namespace bridge

#else

#include <mutex>
#include <shared_mutex>

namespace bridge {
namespace platform {

using Mutex = std::mutex;
using SharedMutex = std::shared_mutex;

template<typename M>
using LockGuard = std::lock_guard<M>;

template<typename M>
using UniqueLock = std::unique_lock<M>;

template<typename M>
using SharedLock = std::shared_lock<M>;

} // namespace platform
} // namespace bridge

#endif
